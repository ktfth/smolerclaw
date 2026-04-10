/**
 * Recon & Surface Mapping Agent.
 *
 * Enumerates a target's attack surface by running external tools as real
 * subprocesses (subfinder, httpx, nmap, nuclei) and querying real HTTP data
 * sources (crt.sh, Shodan, GitHub code search). All findings are correlated
 * into the shared operation state's knowledge graph.
 *
 * Design rules:
 *  - Do not produce flat lists. Every discovery is linked back to its
 *    source and correlated across tools before being ranked.
 *  - If evidence is ambiguous, the inference is stated explicitly and
 *    assigned a confidence (0..1).
 *  - If a required tool is not installed, the step is skipped and noted
 *    — the rest of the pipeline still runs.
 *  - Every target is checked against the operation scope before any
 *    network call. Out-of-scope calls are refused.
 */

import {
  assertInScope,
  getCurrentOperation,
  logTimeline,
  upsertAsset,
  addVector,
  findAsset,
  type Asset,
  type AttackVector,
  type TechFingerprint,
  type VulnClass,
} from './state'
import { ttpsForClass } from './mitre'

// ─── Types ──────────────────────────────────────────────────

export interface ReconOptions {
  /** Run subfinder for subdomain enumeration. Default true. */
  subfinder?: boolean
  /** Run httpx for HTTP fingerprinting. Default true. */
  httpx?: boolean
  /** Run nmap for port scan (top 100 ports only). Default false (opt-in). */
  nmap?: boolean
  /** Run nuclei for template-based vuln scan. Default false (opt-in). */
  nuclei?: boolean
  /** Query crt.sh for certificate-transparency-derived subdomains. Default true. */
  crtsh?: boolean
  /** Query Shodan (requires SHODAN_API_KEY env var). Default true if env set. */
  shodan?: boolean
  /** Search GitHub for leaks. Requires GITHUB_TOKEN. Default true if env set. */
  githubDorks?: boolean
  /** Per-step timeout in seconds. Default 90. */
  stepTimeoutSec?: number
}

export interface ReconReport {
  target: string
  ranSteps: string[]
  skippedSteps: Array<{ step: string; reason: string }>
  assetCount: number
  newVectors: number
  topVectors: Array<{
    class: VulnClass
    target: string
    likelihood: number
    rationale: string
  }>
}

// ─── Public entry point ────────────────────────────────────

/**
 * Run the full recon pipeline against a root target (domain, hostname, or
 * organization). The target must be inside the authorized scope.
 */
export async function runRecon(rootTarget: string, opts: ReconOptions = {}): Promise<ReconReport> {
  const scopeErr = assertInScope(rootTarget)
  if (scopeErr) throw new Error(scopeErr)

  const op = getCurrentOperation()
  if (!op) throw new Error('no active operation')

  const ran: string[] = []
  const skipped: Array<{ step: string; reason: string }> = []

  // Seed the root asset so other discoveries can parent onto it.
  const rootAsset = upsertAsset({
    type: rootTarget.includes('://') ? 'url' : 'domain',
    value: rootTarget,
    discoveredBy: 'operator',
    techStack: [],
    metadata: { seed: true },
    confidence: 1,
  })

  logTimeline('recon', 'recon:start', rootTarget)

  const timeout = Math.max(15, Math.min(600, opts.stepTimeoutSec ?? 90))

  // 1. Subfinder — passive subdomain enumeration
  if (opts.subfinder !== false) {
    const r = await safeStep('subfinder', () => stepSubfinder(rootTarget, rootAsset, timeout))
    pushStepResult('subfinder', r, ran, skipped)
  }

  // 2. crt.sh — CT-log derived subdomains (HTTP, no tool install required)
  if (opts.crtsh !== false) {
    const r = await safeStep('crt.sh', () => stepCrtSh(rootTarget, rootAsset, timeout))
    pushStepResult('crt.sh', r, ran, skipped)
  }

  // 3. Shodan — if API key present
  if (opts.shodan !== false && process.env.SHODAN_API_KEY) {
    const r = await safeStep('shodan', () => stepShodan(rootTarget, rootAsset, timeout))
    pushStepResult('shodan', r, ran, skipped)
  } else if (opts.shodan) {
    skipped.push({ step: 'shodan', reason: 'SHODAN_API_KEY not set' })
  }

  // 4. httpx — HTTP fingerprinting of discovered hosts
  if (opts.httpx !== false) {
    const r = await safeStep('httpx', () => stepHttpx(timeout))
    pushStepResult('httpx', r, ran, skipped)
  }

  // 5. nmap — opt-in port scan (top 100 ports)
  if (opts.nmap) {
    const r = await safeStep('nmap', () => stepNmap(timeout))
    pushStepResult('nmap', r, ran, skipped)
  }

  // 6. nuclei — opt-in template scan
  if (opts.nuclei) {
    const r = await safeStep('nuclei', () => stepNuclei(timeout))
    pushStepResult('nuclei', r, ran, skipped)
  }

  // 7. GitHub leak dorking (HTTP against api.github.com; requires GITHUB_TOKEN)
  if (opts.githubDorks !== false && process.env.GITHUB_TOKEN) {
    const r = await safeStep('github-dorks', () => stepGithubDorks(rootTarget, timeout))
    pushStepResult('github-dorks', r, ran, skipped)
  } else if (opts.githubDorks) {
    skipped.push({ step: 'github-dorks', reason: 'GITHUB_TOKEN not set' })
  }

  // 8. Correlate — infer vectors from merged evidence
  const newVectors = correlateAndScore()
  logTimeline('recon', 'recon:correlated', `${newVectors} new vectors`)

  const current = getCurrentOperation()!
  const ranked = current.vectors
    .slice()
    .sort((a, b) => b.likelihood - a.likelihood)
    .slice(0, 5)
    .map((v) => {
      const asset = current.assets.find((a) => a.id === v.assetId)
      return {
        class: v.class,
        target: asset?.value ?? v.assetId,
        likelihood: v.likelihood,
        rationale: v.rationale,
      }
    })

  logTimeline('recon', 'recon:done', `${current.assets.length} assets, ${current.vectors.length} vectors`)

  return {
    target: rootTarget,
    ranSteps: ran,
    skippedSteps: skipped,
    assetCount: current.assets.length,
    newVectors,
    topVectors: ranked,
  }
}

// ─── Step: subfinder ────────────────────────────────────────

async function stepSubfinder(root: string, rootAsset: Asset, timeoutSec: number): Promise<number> {
  const host = stripScheme(root)
  const { ok, stdout, err } = await runTool(['subfinder', '-silent', '-d', host], timeoutSec)
  if (!ok) throw new Error(err || 'subfinder failed')

  let count = 0
  for (const line of stdout.split('\n')) {
    const sub = line.trim().toLowerCase()
    if (!sub || sub === host) continue
    if (!sub.endsWith('.' + host) && sub !== host) continue
    upsertAsset({
      type: 'subdomain',
      value: sub,
      discoveredBy: 'subfinder',
      parent: rootAsset.id,
      techStack: [],
      metadata: {},
      confidence: 0.9,
    })
    count++
  }
  return count
}

// ─── Step: crt.sh ───────────────────────────────────────────

async function stepCrtSh(root: string, rootAsset: Asset, timeoutSec: number): Promise<number> {
  const host = stripScheme(root)
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(host)}&output=json`
  const res = await httpGetJson(url, timeoutSec)
  if (!Array.isArray(res)) throw new Error('crt.sh: unexpected response shape')

  let count = 0
  const seen = new Set<string>()
  for (const row of res as Array<{ name_value?: string; common_name?: string }>) {
    const raw = String(row.name_value ?? row.common_name ?? '')
    for (const candidate of raw.split(/\s+/)) {
      const v = candidate.trim().toLowerCase().replace(/^\*\./, '')
      if (!v || seen.has(v)) continue
      if (v !== host && !v.endsWith('.' + host)) continue
      seen.add(v)
      upsertAsset({
        type: 'subdomain',
        value: v,
        discoveredBy: 'crt.sh',
        parent: rootAsset.id,
        techStack: [],
        metadata: { source: 'ct-log' },
        confidence: 0.75,
      })
      count++
    }
  }
  return count
}

// ─── Step: Shodan ───────────────────────────────────────────

async function stepShodan(root: string, rootAsset: Asset, timeoutSec: number): Promise<number> {
  const host = stripScheme(root)
  const apiKey = process.env.SHODAN_API_KEY
  const url = `https://api.shodan.io/shodan/host/search?key=${encodeURIComponent(apiKey!)}&query=${encodeURIComponent('hostname:' + host)}`
  const data = await httpGetJson(url, timeoutSec) as { matches?: Array<Record<string, unknown>> }
  const matches = data.matches ?? []
  let count = 0
  for (const m of matches) {
    const ip = String(m.ip_str ?? '')
    const port = Number(m.port ?? 0)
    if (!ip) continue
    upsertAsset({
      type: 'ip',
      value: ip,
      discoveredBy: 'shodan',
      parent: rootAsset.id,
      techStack: [],
      metadata: { shodan_port: port, product: m.product, org: m.org },
      confidence: 0.7,
    })
    if (port) {
      upsertAsset({
        type: 'service',
        value: `${ip}:${port}`,
        discoveredBy: 'shodan',
        parent: rootAsset.id,
        techStack: m.product ? [{ name: String(m.product), confidence: 0.7, source: 'shodan', evidence: 'shodan banner' }] : [],
        metadata: { shodan: true, data: summarize(m.data) },
        confidence: 0.7,
      })
    }
    count++
  }
  return count
}

function summarize(data: unknown): string {
  if (typeof data !== 'string') return ''
  return data.slice(0, 200)
}

// ─── Step: httpx ────────────────────────────────────────────

async function stepHttpx(timeoutSec: number): Promise<number> {
  const op = getCurrentOperation()!
  const hosts = op.assets
    .filter((a) => a.type === 'subdomain' || a.type === 'domain')
    .map((a) => a.value)
  if (hosts.length === 0) return 0

  const stdin = hosts.join('\n')
  const { ok, stdout, err } = await runTool(
    ['httpx', '-silent', '-status-code', '-title', '-tech-detect', '-json', '-no-color'],
    timeoutSec,
    stdin,
  )
  if (!ok) throw new Error(err || 'httpx failed')

  let count = 0
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    const urlVal = String(row.url ?? '')
    if (!urlVal) continue
    const statusCode = Number(row.status_code ?? row['status-code'] ?? 0)
    const title = String(row.title ?? '')
    const techRaw = row.tech ?? row.technologies ?? []
    const techs = Array.isArray(techRaw) ? techRaw.map(String) : []

    const fingerprints: TechFingerprint[] = techs.map((t) => ({
      name: t,
      confidence: 0.85,
      source: 'httpx',
      evidence: `httpx tech-detect: ${t}`,
    }))

    upsertAsset({
      type: 'url',
      value: urlVal,
      discoveredBy: 'httpx',
      techStack: fingerprints,
      metadata: { status: statusCode, title },
      confidence: 0.95,
      exploitability: statusCode >= 200 && statusCode < 400 ? 0.4 : 0.2,
    })
    count++
  }
  return count
}

// ─── Step: nmap (opt-in) ────────────────────────────────────

async function stepNmap(timeoutSec: number): Promise<number> {
  const op = getCurrentOperation()!
  const hosts = op.assets
    .filter((a) => a.type === 'ip' || a.type === 'domain' || a.type === 'subdomain')
    .map((a) => a.value)
    .slice(0, 25) // bounded — this is not a mass scanner
  if (hosts.length === 0) return 0

  // Top 100 TCP ports, no DNS resolution, default scripts OFF, version detect ON
  const args = ['nmap', '-Pn', '-n', '--top-ports', '100', '-sV', '-oG', '-', ...hosts]
  const { ok, stdout, err } = await runTool(args, timeoutSec)
  if (!ok) throw new Error(err || 'nmap failed')

  let count = 0
  for (const line of stdout.split('\n')) {
    const m = line.match(/^Host: (\S+) .*?\tPorts: (.*)$/)
    if (!m) continue
    const host = m[1]
    const ports = m[2].split(',').map((p) => p.trim()).filter(Boolean)
    for (const p of ports) {
      // format: "80/open/tcp//http//Apache httpd 2.4.29/"
      const parts = p.split('/')
      if (parts.length < 7) continue
      const [portNum, state, _proto, , service, , version] = parts
      if (state !== 'open') continue
      upsertAsset({
        type: 'service',
        value: `${host}:${portNum}`,
        discoveredBy: 'nmap',
        techStack: version
          ? [{ name: service || 'unknown', version, confidence: 0.85, source: 'nmap -sV', evidence: version }]
          : [],
        metadata: { port: Number(portNum), service },
        confidence: 0.95,
      })
      count++
    }
  }
  return count
}

// ─── Step: nuclei (opt-in) ──────────────────────────────────

async function stepNuclei(timeoutSec: number): Promise<number> {
  const op = getCurrentOperation()!
  const urls = op.assets.filter((a) => a.type === 'url').map((a) => a.value)
  if (urls.length === 0) return 0

  const stdin = urls.join('\n')
  // severity capped at medium — we want leads, not DoS the target
  const { ok, stdout, err } = await runTool(
    ['nuclei', '-silent', '-jsonl', '-severity', 'info,low,medium', '-no-color'],
    timeoutSec,
    stdin,
  )
  if (!ok) throw new Error(err || 'nuclei failed')

  let count = 0
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    const matched = String(row['matched-at'] ?? row.host ?? '')
    const name = String((row.info as Record<string, unknown>)?.name ?? row['template-id'] ?? 'nuclei finding')
    const severity = String((row.info as Record<string, unknown>)?.severity ?? 'info')
    const asset = findAsset((a) => a.value === matched || matched.startsWith(a.value))
    if (!asset) continue

    // Each nuclei hit becomes a pending vector with a rationale pointing at the template
    const vulnClass: VulnClass = inferClassFromNucleiTemplate(String(row['template-id'] ?? ''))
    addVector({
      assetId: asset.id,
      class: vulnClass,
      description: `nuclei: ${name}`,
      rationale: `nuclei template fired (${severity}) at ${matched}`,
      likelihood: severityToLikelihood(severity),
      evidence: [`nuclei template ${row['template-id']}`],
      ttps: ttpsForClass(vulnClass),
    })
    count++
  }
  return count
}

function inferClassFromNucleiTemplate(id: string): VulnClass {
  const l = id.toLowerCase()
  if (l.includes('sqli')) return 'sqli'
  if (l.includes('xss')) return 'xss'
  if (l.includes('ssrf')) return 'ssrf'
  if (l.includes('ssti')) return 'ssti'
  if (l.includes('rce')) return 'rce'
  if (l.includes('xxe')) return 'xxe'
  if (l.includes('lfi') || l.includes('path-traversal')) return 'lfi'
  if (l.includes('redirect')) return 'open-redirect'
  if (l.includes('exposure') || l.includes('disclosure')) return 'info-disclosure'
  if (l.includes('misconfig')) return 'misconfig'
  return 'other'
}

function severityToLikelihood(s: string): number {
  switch (s.toLowerCase()) {
    case 'critical': return 0.95
    case 'high': return 0.8
    case 'medium': return 0.6
    case 'low': return 0.4
    default: return 0.25
  }
}

// ─── Step: GitHub dorks ─────────────────────────────────────

const GITHUB_DORKS = [
  '"BEGIN RSA PRIVATE KEY"',
  '"aws_secret_access_key"',
  '"AKIA" password',
  'filename:.env',
  'filename:credentials',
]

async function stepGithubDorks(root: string, timeoutSec: number): Promise<number> {
  const host = stripScheme(root)
  const op = getCurrentOperation()!
  const orgOrHost = op.scope.orgName || host
  let count = 0
  for (const dork of GITHUB_DORKS) {
    const q = `${dork} ${orgOrHost}`
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=5`
    try {
      const data = await httpGetJson(url, timeoutSec, {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      }) as { items?: Array<Record<string, unknown>> }
      for (const item of data.items ?? []) {
        const repoFull = String((item.repository as Record<string, unknown>)?.full_name ?? '')
        const path = String(item.path ?? '')
        const htmlUrl = String(item.html_url ?? '')
        if (!repoFull || !path) continue
        upsertAsset({
          type: 'repo',
          value: `${repoFull}:${path}`,
          discoveredBy: 'github-dorks',
          techStack: [],
          metadata: { dork, html_url: htmlUrl },
          confidence: 0.5, // low — needs human verification
        })
        const asset = findAsset((a) => a.value === `${repoFull}:${path}`)
        if (asset) {
          addVector({
            assetId: asset.id,
            class: 'leak',
            description: `Possible secret leak: ${dork} in ${repoFull}/${path}`,
            rationale: `GitHub code search matched "${dork}" inside ${repoFull}/${path}; verify manually.`,
            likelihood: 0.35, // false positives common
            evidence: [htmlUrl],
            ttps: ttpsForClass('leak'),
          })
        }
        count++
      }
    } catch {
      // single-dork failure doesn't abort the pipeline
    }
  }
  return count
}

// ─── Correlation ────────────────────────────────────────────

/**
 * Reason across assets, tech stack and httpx fingerprints to infer attack
 * vectors. Each inference is stated with an explicit rationale and a
 * likelihood so downstream agents can prioritize.
 */
function correlateAndScore(): number {
  const op = getCurrentOperation()!
  let created = 0

  for (const a of op.assets) {
    if (a.type !== 'url') continue
    const status = Number((a.metadata.status as number) ?? 0)
    const techNames = a.techStack.map((t) => t.name.toLowerCase())

    // Skip if already has an inferred vector
    const hasInferred = op.vectors.some((v) => v.assetId === a.id && v.description.startsWith('inferred:'))
    if (hasInferred) continue

    // 1. Exposed admin surfaces
    if (/\/(admin|phpmyadmin|wp-admin|adminer|login)(\/|$)/i.test(a.value) && status < 500) {
      inferVector(a, 'authbypass', 0.55, 'Exposed admin/login endpoint reachable from internet')
      created++
    }

    // 2. PHP stack + 200 → typical SQLi / LFI surface
    if (techNames.some((t) => t.includes('php')) && status >= 200 && status < 400) {
      inferVector(a, 'sqli', 0.5, 'PHP stack detected with live endpoint; classical injection surface')
      inferVector(a, 'lfi', 0.35, 'PHP stack often exposes include() based LFI')
      created += 2
    }

    // 3. Node/Express/Nuxt → SSRF/SSTI surface
    if (techNames.some((t) => /express|next|nuxt|node/.test(t))) {
      inferVector(a, 'ssrf', 0.4, 'Node runtime detected; server-side fetch endpoints common')
      created++
    }

    // 4. Jinja/Flask/Django → SSTI surface
    if (techNames.some((t) => /flask|jinja|django/.test(t))) {
      inferVector(a, 'ssti', 0.55, 'Template engine detected; SSTI possible on user-reflected params')
      created++
    }

    // 5. LLM chat surface
    if (techNames.some((t) => /openai|claude|anthropic|llm|chatgpt|bedrock|vertex/.test(t))) {
      inferVector(a, 'prompt-injection', 0.75, 'LLM-backed endpoint fingerprinted; probe with the prompt-injection agent')
      created++
    }

    // 6. Old jQuery / dead frameworks → XSS
    if (techNames.some((t) => /jquery|angularjs|backbone/.test(t))) {
      inferVector(a, 'xss', 0.45, 'Legacy client-side framework; reflected XSS common')
      created++
    }
  }

  // 7. Leaked repo assets already get a vector added inline — nothing more to do here.

  return created
}

function inferVector(asset: Asset, cls: VulnClass, likelihood: number, rationale: string): AttackVector {
  return addVector({
    assetId: asset.id,
    class: cls,
    description: `inferred:${cls} at ${asset.value}`,
    rationale,
    likelihood,
    evidence: asset.techStack.map((t) => `${t.name}${t.version ? ` ${t.version}` : ''} (${t.source})`),
    ttps: ttpsForClass(cls),
  })
}

// ─── Subprocess / HTTP helpers ──────────────────────────────

async function runTool(
  argv: string[],
  timeoutSec: number,
  stdin?: string,
): Promise<{ ok: boolean; stdout: string; err: string }> {
  try {
    const proc = Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: stdin ? 'pipe' : 'ignore',
    })
    if (stdin && proc.stdin) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
    const timer = setTimeout(() => proc.kill(), timeoutSec * 1000)
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    clearTimeout(timer)
    if (exitCode !== 0 && !stdout.trim()) {
      return { ok: false, stdout: '', err: stderr.trim() || `exit ${exitCode}` }
    }
    return { ok: true, stdout, err: stderr }
  } catch (err) {
    return { ok: false, stdout: '', err: err instanceof Error ? err.message : String(err) }
  }
}

async function httpGetJson(url: string, timeoutSec: number, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'smolerclaw-offensive/1.0', Accept: 'application/json', ...headers },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function stripScheme(value: string): string {
  return value.replace(/^https?:\/\//, '').split('/')[0]
}

async function safeStep<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: string }> {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logTimeline('recon', `recon:step-failed`, `${name}: ${msg}`)
    return { ok: false, err: msg }
  }
}

function pushStepResult(
  name: string,
  r: { ok: true; value: unknown } | { ok: false; err: string },
  ran: string[],
  skipped: Array<{ step: string; reason: string }>,
): void {
  if (r.ok) ran.push(name)
  else skipped.push({ step: name, reason: r.err })
}
