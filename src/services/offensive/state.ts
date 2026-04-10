/**
 * Offensive Operations — Shared Operation State / Knowledge Graph
 *
 * A single persistent, queryable operation context passed to every offensive
 * agent (Recon, Payload Mutation, Prompt Injection). Models the target as an
 * evolving graph of assets, inferred technology, attack vectors, attempts and
 * findings — so each agent can reason over what the others have learned.
 *
 * Authorization-first: no action in any agent may proceed unless the operator
 * has explicitly marked the scope as authorized (CTF / pentest engagement /
 * red-team exercise / lab). All actions run against real subprocesses or real
 * HTTP targets and are logged to the state timeline for audit.
 *
 * Storage: one JSON file per operation under `<dataDir>/offensive-ops/`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFile } from '../../vault'

// ─── Types ──────────────────────────────────────────────────

export type KillChainPhase =
  | 'reconnaissance'
  | 'weaponization'
  | 'delivery'
  | 'exploitation'
  | 'installation'
  | 'command-and-control'
  | 'actions-on-objectives'

export type VectorOutcome = 'succeeded' | 'failed' | 'inconclusive' | 'pending'

export type VulnClass =
  | 'sqli'
  | 'xss'
  | 'ssti'
  | 'ssrf'
  | 'rce'
  | 'idor'
  | 'authbypass'
  | 'lfi'
  | 'xxe'
  | 'open-redirect'
  | 'prompt-injection'
  | 'indirect-prompt-injection'
  | 'tool-poisoning'
  | 'info-disclosure'
  | 'misconfig'
  | 'leak'
  | 'other'

export type AssetType =
  | 'domain'
  | 'subdomain'
  | 'ip'
  | 'url'
  | 'service'
  | 'repo'
  | 'email'
  | 'endpoint'

export type AgentId = 'recon' | 'payload' | 'prompt-inject' | 'operator'

export interface OperationScope {
  /** Stable operation identifier. */
  operationId: string
  /** Human-readable operation name (engagement, CTF, lab, etc.). */
  name: string
  /** Authorization MUST be true before any agent will act. */
  authorized: boolean
  /**
   * Free-text justification: engagement ID, bug bounty program, CTF name,
   * internal lab notice. Saved to audit log.
   */
  authorization: string
  /** Authorized root domains (subdomains auto-allowed). */
  domains: string[]
  /** Authorized IPs or CIDRs. */
  ips: string[]
  /** Authorized URL prefixes (exact scheme+host+path prefix). */
  urls: string[]
  /** Optional organization name for recon correlation. */
  orgName?: string
  createdAt: string
  updatedAt: string
}

export interface TechFingerprint {
  name: string
  version?: string
  /** 0..1 — confidence the target runs this tech. */
  confidence: number
  /** Where the inference came from (header, body, behavior, tool). */
  source: string
  /** Supporting evidence snippet (short, redacted). */
  evidence: string
}

export interface Asset {
  id: string
  type: AssetType
  /** Canonical value: domain, "host:port", URL, IP, email, repo URL, etc. */
  value: string
  /** Source tool/agent that first discovered this asset. */
  discoveredBy: string
  discoveredAt: string
  /** Parent asset id (e.g., subdomain -> root domain). */
  parent?: string
  /** Inferred tech stack. Multiple entries allowed. */
  techStack: TechFingerprint[]
  /** Arbitrary metadata (ports, titles, status, cert info...). */
  metadata: Record<string, unknown>
  /** 0..1 — confidence the asset belongs to the target. */
  confidence: number
  /** 0..1 — exploitability score, updated as vectors land. */
  exploitability: number
}

export interface VectorAttempt {
  timestamp: string
  /** Raw payload sent (truncated for storage). */
  payload: string
  /** SHA-256 of the full payload; used to dedupe retries. */
  payloadHash: string
  response: {
    status?: number
    latencyMs?: number
    bodySnippet?: string
    headers?: Record<string, string>
  }
  /** Detected signals: waf:cloudflare, reflected, error:sql, delta:latency... */
  signals: string[]
  outcome: VectorOutcome
  /** Model/operator reasoning about the outcome. */
  reasoning: string
}

export interface AttackVector {
  id: string
  assetId: string
  class: VulnClass
  description: string
  /** Why we think this vector is viable (correlated evidence). */
  rationale: string
  /** 0..1 exploitability likelihood. */
  likelihood: number
  evidence: string[]
  /** MITRE ATT&CK / ATLAS TTP IDs (e.g., T1190, AML.T0051). */
  ttps: string[]
  status: VectorOutcome
  attempts: VectorAttempt[]
  createdAt: string
  updatedAt: string
}

export interface Finding {
  id: string
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  title: string
  description: string
  assetId?: string
  vectorId?: string
  ttps: string[]
  evidence: string[]
  remediation: string
  createdAt: string
}

export interface TimelineEntry {
  timestamp: string
  actor: AgentId
  action: string
  details: string
}

export interface OperationState {
  scope: OperationScope
  phase: KillChainPhase
  assets: Asset[]
  vectors: AttackVector[]
  findings: Finding[]
  timeline: TimelineEntry[]
}

// ─── Module State ───────────────────────────────────────────

let _dataDir = ''
let _current: OperationState | null = null
let _initialized = false

const OPS_DIR = () => join(_dataDir, 'offensive-ops')
const OPS_FILE = (id: string) => join(OPS_DIR(), `${id}.json`)

// ─── Initialization ─────────────────────────────────────────

/**
 * Initialize the offensive operations subsystem. Creates the storage
 * directory under the provided data dir. Idempotent.
 */
export function initOffensiveOps(dataDir: string): void {
  _dataDir = dataDir
  const dir = OPS_DIR()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  _initialized = true
}

export function isOffensiveOpsInitialized(): boolean {
  return _initialized
}

// ─── Operation Lifecycle ────────────────────────────────────

/**
 * Create a new operation. The operation is NOT authorized by default; call
 * authorizeOperation() with an explicit justification before any agent will
 * perform actions against the target.
 */
export function createOperation(
  name: string,
  opts?: {
    domains?: string[]
    ips?: string[]
    urls?: string[]
    orgName?: string
  },
): OperationState {
  if (!_initialized) throw new Error('offensive-ops not initialized')

  const now = new Date().toISOString()
  const operationId = shortId()
  const op: OperationState = {
    scope: {
      operationId,
      name,
      authorized: false,
      authorization: '',
      domains: uniq(opts?.domains ?? []),
      ips: uniq(opts?.ips ?? []),
      urls: uniq(opts?.urls ?? []),
      orgName: opts?.orgName,
      createdAt: now,
      updatedAt: now,
    },
    phase: 'reconnaissance',
    assets: [],
    vectors: [],
    findings: [],
    timeline: [{
      timestamp: now,
      actor: 'operator',
      action: 'operation:created',
      details: `Operation "${name}" created (unauthorized).`,
    }],
  }

  _current = op
  persist(op)
  return op
}

/**
 * Explicitly mark the current operation as authorized. Required before any
 * agent will perform a probe. The justification is logged to the audit
 * timeline and should identify the engagement context (bug bounty, CTF, lab).
 */
export function authorizeOperation(justification: string): void {
  const op = requireCurrent()
  if (!justification.trim()) {
    throw new Error('authorization justification is required')
  }
  op.scope.authorized = true
  op.scope.authorization = justification.trim()
  op.scope.updatedAt = new Date().toISOString()
  logTimeline('operator', 'operation:authorized', justification.trim())
  persist(op)
}

/**
 * Revoke authorization. Subsequent agent actions will be refused.
 */
export function revokeAuthorization(reason: string): void {
  const op = requireCurrent()
  op.scope.authorized = false
  op.scope.updatedAt = new Date().toISOString()
  logTimeline('operator', 'operation:revoked', reason || 'no reason given')
  persist(op)
}

/** Load an operation from disk and make it the current one. */
export function loadOperation(operationId: string): OperationState {
  if (!_initialized) throw new Error('offensive-ops not initialized')
  const file = OPS_FILE(operationId)
  if (!existsSync(file)) {
    throw new Error(`operation ${operationId} not found`)
  }
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as OperationState
  _current = raw
  return raw
}

export function listOperations(): Array<{ operationId: string; name: string; createdAt: string; authorized: boolean }> {
  if (!_initialized) return []
  const dir = OPS_DIR()
  if (!existsSync(dir)) return []
  const out: Array<{ operationId: string; name: string; createdAt: string; authorized: boolean }> = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as OperationState
      out.push({
        operationId: raw.scope.operationId,
        name: raw.scope.name,
        createdAt: raw.scope.createdAt,
        authorized: raw.scope.authorized,
      })
    } catch {
      // skip corrupted
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Return the currently-loaded operation, or null if none. */
export function getCurrentOperation(): OperationState | null {
  return _current
}

export function setKillChainPhase(phase: KillChainPhase): void {
  const op = requireCurrent()
  op.phase = phase
  logTimeline('operator', 'phase:update', phase)
  persist(op)
}

// ─── Scope Enforcement ──────────────────────────────────────

/**
 * Check whether a target (URL, domain, IP) is inside the authorized scope.
 * Returns null if allowed, or an error string describing the refusal.
 *
 * This is the central authorization gate used by every agent.
 */
export function assertInScope(target: string): string | null {
  const op = _current
  if (!op) return 'Error: no active operation.'
  if (!op.scope.authorized) {
    return 'Error: operation is not authorized. Call scope_authorize with an explicit engagement justification before running any agent.'
  }

  const trimmed = target.trim()
  if (!trimmed) return 'Error: empty target.'

  // URL prefix match
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed)
      const host = url.hostname.toLowerCase()
      // authorized via explicit URL prefix
      for (const prefix of op.scope.urls) {
        if (trimmed.startsWith(prefix)) return null
      }
      // authorized via domain match
      if (hostInDomains(host, op.scope.domains)) return null
      // authorized via IP (if host is an IP)
      if (isIp(host) && ipInList(host, op.scope.ips)) return null
      return `Error: target host "${host}" is not in authorized scope.`
    } catch {
      return 'Error: invalid URL target.'
    }
  }

  // Bare IP
  if (isIp(trimmed)) {
    if (ipInList(trimmed, op.scope.ips)) return null
    return `Error: IP ${trimmed} is not in authorized scope.`
  }

  // Domain / hostname
  const host = trimmed.toLowerCase()
  if (hostInDomains(host, op.scope.domains)) return null
  return `Error: host "${host}" is not in authorized scope.`
}

function hostInDomains(host: string, domains: string[]): boolean {
  const h = host.toLowerCase()
  for (const d of domains) {
    const dl = d.toLowerCase().replace(/^\*\./, '')
    if (h === dl) return true
    if (h.endsWith('.' + dl)) return true
  }
  return false
}

function isIp(value: string): boolean {
  // naive IPv4 check — sufficient for scope gate
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value)
}

function ipInList(ip: string, list: string[]): boolean {
  for (const entry of list) {
    if (entry.includes('/')) {
      if (ipInCidr(ip, entry)) return true
    } else if (entry === ip) {
      return true
    }
  }
  return false
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr)
  if (!isFinite(bits) || bits < 0 || bits > 32) return false
  const toInt = (s: string) => s.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0
  const ipInt = toInt(ip)
  const baseInt = toInt(base)
  if (bits === 0) return true
  const mask = (~0 << (32 - bits)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

// ─── Asset graph mutations ──────────────────────────────────

/**
 * Add or merge an asset. If an asset with the same type+value already exists,
 * tech stack and metadata are merged and confidence is updated to the max.
 */
export function upsertAsset(input: Omit<Asset, 'id' | 'discoveredAt' | 'exploitability'> & { exploitability?: number }): Asset {
  const op = requireCurrent()
  const existing = op.assets.find((a) => a.type === input.type && a.value === input.value)
  const now = new Date().toISOString()

  if (existing) {
    for (const t of input.techStack) {
      const match = existing.techStack.find((x) => x.name === t.name)
      if (match) {
        match.confidence = Math.max(match.confidence, t.confidence)
        if (t.version && !match.version) match.version = t.version
      } else {
        existing.techStack.push(t)
      }
    }
    existing.metadata = { ...existing.metadata, ...input.metadata }
    existing.confidence = Math.max(existing.confidence, input.confidence)
    if (input.exploitability !== undefined) {
      existing.exploitability = Math.max(existing.exploitability, input.exploitability)
    }
    logTimeline(asAgent(input.discoveredBy), 'asset:updated', `${existing.type} ${existing.value}`)
    persist(op)
    return existing
  }

  const asset: Asset = {
    id: shortId(),
    type: input.type,
    value: input.value,
    discoveredBy: input.discoveredBy,
    discoveredAt: now,
    parent: input.parent,
    techStack: input.techStack,
    metadata: input.metadata,
    confidence: input.confidence,
    exploitability: input.exploitability ?? 0,
  }
  op.assets.push(asset)
  logTimeline(asAgent(input.discoveredBy), 'asset:added', `${asset.type} ${asset.value}`)
  persist(op)
  return asset
}

export function findAsset(predicate: (a: Asset) => boolean): Asset | undefined {
  const op = _current
  if (!op) return undefined
  return op.assets.find(predicate)
}

// ─── Vector tracking ────────────────────────────────────────

export function addVector(v: Omit<AttackVector, 'id' | 'attempts' | 'status' | 'createdAt' | 'updatedAt'>): AttackVector {
  const op = requireCurrent()
  const now = new Date().toISOString()
  const vec: AttackVector = {
    id: shortId(),
    attempts: [],
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...v,
  }
  op.vectors.push(vec)
  logTimeline('operator', 'vector:added', `${vec.class} on asset ${vec.assetId}`)
  persist(op)
  return vec
}

export function recordAttempt(vectorId: string, attempt: Omit<VectorAttempt, 'payloadHash' | 'timestamp'> & { timestamp?: string }): VectorAttempt {
  const op = requireCurrent()
  const vec = op.vectors.find((v) => v.id === vectorId)
  if (!vec) throw new Error(`vector ${vectorId} not found`)
  const hash = sha256(attempt.payload)
  const entry: VectorAttempt = {
    ...attempt,
    timestamp: attempt.timestamp ?? new Date().toISOString(),
    payloadHash: hash,
  }
  vec.attempts.push(entry)
  if (entry.outcome !== 'pending') vec.status = entry.outcome
  vec.updatedAt = entry.timestamp
  persist(op)
  return entry
}

/**
 * Has this exact payload already been tried against this vector? Used by the
 * mutation loop to ensure failed payloads are never re-sent.
 */
export function hasAttempted(vectorId: string, payload: string): boolean {
  const op = _current
  if (!op) return false
  const vec = op.vectors.find((v) => v.id === vectorId)
  if (!vec) return false
  const hash = sha256(payload)
  return vec.attempts.some((a) => a.payloadHash === hash)
}

// ─── Findings ───────────────────────────────────────────────

export function addFinding(f: Omit<Finding, 'id' | 'createdAt'>): Finding {
  const op = requireCurrent()
  const finding: Finding = {
    id: shortId(),
    createdAt: new Date().toISOString(),
    ...f,
  }
  op.findings.push(finding)
  logTimeline('operator', 'finding:added', `${finding.severity}: ${finding.title}`)
  persist(op)
  return finding
}

// ─── Prioritization ─────────────────────────────────────────

/**
 * Return the top N attack vectors, ranked by exploitability likelihood and
 * the exploitability score of their target asset. Produces the "prioritized
 * attack surface" required by the spec.
 */
export function prioritizedVectors(limit = 10): Array<{ vector: AttackVector; asset?: Asset; score: number }> {
  const op = _current
  if (!op) return []
  const ranked = op.vectors.map((v) => {
    const asset = op.assets.find((a) => a.id === v.assetId)
    const score = 0.6 * v.likelihood + 0.4 * (asset?.exploitability ?? 0)
    return { vector: v, asset, score }
  })
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, limit)
}

// ─── Queries / reporting ────────────────────────────────────

export interface OperationReport {
  operation: { id: string; name: string; phase: KillChainPhase; authorized: boolean }
  scope: OperationScope
  counts: { assets: number; vectors: number; findings: number }
  topVectors: Array<{ class: VulnClass; target: string; likelihood: number; score: number; rationale: string }>
  findings: Finding[]
  ttps: string[]
  recommendedNext: string[]
}

export function buildReport(): OperationReport {
  const op = requireCurrent()
  const top = prioritizedVectors(10).map(({ vector, asset, score }) => ({
    class: vector.class,
    target: asset ? asset.value : vector.assetId,
    likelihood: vector.likelihood,
    score,
    rationale: vector.rationale,
  }))
  const ttps = uniq([
    ...op.vectors.flatMap((v) => v.ttps),
    ...op.findings.flatMap((f) => f.ttps),
  ])
  const recs: string[] = []
  if (op.assets.length === 0) {
    recs.push('Run the recon agent (`offensive_recon`) to enumerate the surface.')
  }
  if (op.vectors.filter((v) => v.status === 'pending').length > 0) {
    recs.push('Run payload mutation against the highest-likelihood pending vectors.')
  }
  if (op.assets.some((a) => a.techStack.some((t) => /llm|openai|claude|gpt|anthropic|bedrock/i.test(t.name)))) {
    recs.push('Run the prompt-injection prober against LLM-backed endpoints.')
  }
  if (op.findings.length === 0) {
    recs.push('No findings yet — iterate recon → payload mutation until at least one vector resolves.')
  }
  return {
    operation: {
      id: op.scope.operationId,
      name: op.scope.name,
      phase: op.phase,
      authorized: op.scope.authorized,
    },
    scope: op.scope,
    counts: {
      assets: op.assets.length,
      vectors: op.vectors.length,
      findings: op.findings.length,
    },
    topVectors: top,
    findings: op.findings,
    ttps,
    recommendedNext: recs,
  }
}

// ─── Audit / Timeline ───────────────────────────────────────

export function logTimeline(actor: AgentId, action: string, details: string): void {
  const op = _current
  if (!op) return
  op.timeline.push({
    timestamp: new Date().toISOString(),
    actor,
    action,
    details,
  })
}

// ─── Helpers ────────────────────────────────────────────────

function requireCurrent(): OperationState {
  if (!_current) {
    throw new Error('No active operation. Create one with createOperation() first.')
  }
  return _current
}

function persist(op: OperationState): void {
  if (!_dataDir) return
  atomicWriteFile(OPS_FILE(op.scope.operationId), JSON.stringify(op, null, 2))
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

function asAgent(source: string): AgentId {
  if (source === 'recon' || source === 'payload' || source === 'prompt-inject' || source === 'operator') {
    return source
  }
  if (source.startsWith('recon') || /subfinder|httpx|nmap|nuclei|shodan|crt\.sh/.test(source)) return 'recon'
  if (source.startsWith('payload')) return 'payload'
  if (source.includes('prompt')) return 'prompt-inject'
  return 'operator'
}

// Exposed for tests only — DO NOT USE in production code.
export function _resetForTest(): void {
  _current = null
  _initialized = false
  _dataDir = ''
}
