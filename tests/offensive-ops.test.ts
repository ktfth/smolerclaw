/**
 * Offensive Operations test suite.
 *
 * Covers the parts of the offensive-ops subsystem that do not require
 * network or subprocesses: operation lifecycle, scope enforcement, asset
 * graph updates, vector tracking, attempt dedupe, prioritization, MITRE
 * mapping, and report generation.
 *
 * The recon / payload / prompt-injection agents are invoked against real
 * subprocesses and real HTTP targets at runtime — we do not mock them
 * here. Unit coverage focuses on the logic that the agents depend on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  initOffensiveOps,
  isOffensiveOpsInitialized,
  createOperation,
  authorizeOperation,
  revokeAuthorization,
  loadOperation,
  listOperations,
  getCurrentOperation,
  setKillChainPhase,
  assertInScope,
  upsertAsset,
  addVector,
  recordAttempt,
  hasAttempted,
  addFinding,
  prioritizedVectors,
  buildReport,
  _resetForTest,
} from '../src/services/offensive/state'
import { ttpsForClass, describeTTPs } from '../src/services/offensive/mitre'

describe('offensive-ops: lifecycle & scope', () => {
  let tmp: string

  beforeEach(() => {
    _resetForTest()
    tmp = mkdtempSync(join(tmpdir(), 'smolerclaw-off-'))
    initOffensiveOps(tmp)
  })

  afterEach(() => {
    _resetForTest()
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  })

  it('initializes and creates the ops directory', () => {
    expect(isOffensiveOpsInitialized()).toBe(true)
    expect(existsSync(join(tmp, 'offensive-ops'))).toBe(true)
  })

  it('creates an unauthorized operation by default', () => {
    const op = createOperation('test-op', { domains: ['example.com'] })
    expect(op.scope.authorized).toBe(false)
    expect(op.scope.domains).toContain('example.com')
    expect(op.scope.name).toBe('test-op')
    expect(op.phase).toBe('reconnaissance')
  })

  it('refuses scope checks until authorized', () => {
    createOperation('t', { domains: ['example.com'] })
    const err = assertInScope('https://example.com/')
    expect(err).toBeTruthy()
    expect(err).toContain('not authorized')
  })

  it('authorizes with an explicit justification', () => {
    createOperation('t', { domains: ['example.com'] })
    authorizeOperation('bug-bounty engagement BB-42')
    const op = getCurrentOperation()!
    expect(op.scope.authorized).toBe(true)
    expect(op.scope.authorization).toContain('BB-42')
  })

  it('refuses authorization without a justification', () => {
    createOperation('t')
    expect(() => authorizeOperation('   ')).toThrow(/justification/)
  })

  it('revokes authorization', () => {
    createOperation('t', { domains: ['example.com'] })
    authorizeOperation('CTF practice box')
    revokeAuthorization('done')
    expect(getCurrentOperation()!.scope.authorized).toBe(false)
    expect(assertInScope('https://example.com/')).toContain('not authorized')
  })

  it('allows in-scope domains and their subdomains after authorization', () => {
    createOperation('t', { domains: ['example.com'] })
    authorizeOperation('authorized lab')
    expect(assertInScope('example.com')).toBeNull()
    expect(assertInScope('api.example.com')).toBeNull()
    expect(assertInScope('https://www.example.com/path')).toBeNull()
  })

  it('refuses out-of-scope hosts', () => {
    createOperation('t', { domains: ['example.com'] })
    authorizeOperation('lab')
    const err = assertInScope('https://evil.com/')
    expect(err).toContain('not in authorized scope')
  })

  it('allows IPs via exact list', () => {
    createOperation('t', { ips: ['10.0.0.5'] })
    authorizeOperation('lab')
    expect(assertInScope('10.0.0.5')).toBeNull()
    expect(assertInScope('10.0.0.6')).toContain('not in authorized scope')
  })

  it('allows IPs via CIDR', () => {
    createOperation('t', { ips: ['10.0.0.0/24'] })
    authorizeOperation('lab')
    expect(assertInScope('10.0.0.250')).toBeNull()
    expect(assertInScope('10.0.1.1')).toContain('not in authorized scope')
  })

  it('allows explicit URL prefixes', () => {
    createOperation('t', { urls: ['https://api.partner.net/v1/'] })
    authorizeOperation('lab')
    expect(assertInScope('https://api.partner.net/v1/users')).toBeNull()
    expect(assertInScope('https://api.partner.net/v2/users')).toContain('not in authorized scope')
  })

  it('persists operations to disk and re-lists them', () => {
    const op = createOperation('persist-test', { domains: ['foo.example'] })
    authorizeOperation('lab')
    const all = listOperations()
    expect(all.some((o) => o.operationId === op.scope.operationId)).toBe(true)
    const loaded = loadOperation(op.scope.operationId)
    expect(loaded.scope.operationId).toBe(op.scope.operationId)
    expect(loaded.scope.authorized).toBe(true)
  })

  it('updates the kill-chain phase', () => {
    createOperation('t')
    setKillChainPhase('exploitation')
    expect(getCurrentOperation()!.phase).toBe('exploitation')
  })
})

describe('offensive-ops: assets, vectors, attempts', () => {
  let tmp: string

  beforeEach(() => {
    _resetForTest()
    tmp = mkdtempSync(join(tmpdir(), 'smolerclaw-off-'))
    initOffensiveOps(tmp)
    createOperation('graph', { domains: ['example.com'] })
    authorizeOperation('lab')
  })

  afterEach(() => {
    _resetForTest()
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  })

  it('upserts assets and merges tech stacks', () => {
    const a = upsertAsset({
      type: 'url',
      value: 'https://example.com/',
      discoveredBy: 'httpx',
      techStack: [{ name: 'nginx', confidence: 0.8, source: 'httpx', evidence: 'Server: nginx' }],
      metadata: { status: 200 },
      confidence: 0.9,
    })
    const b = upsertAsset({
      type: 'url',
      value: 'https://example.com/',
      discoveredBy: 'nuclei',
      techStack: [
        { name: 'nginx', version: '1.20', confidence: 0.95, source: 'nuclei', evidence: 'Server: nginx/1.20' },
        { name: 'WordPress', confidence: 0.7, source: 'nuclei', evidence: '/wp-login.php' },
      ],
      metadata: { title: 'Home' },
      confidence: 0.95,
    })
    expect(a.id).toBe(b.id)
    expect(b.techStack.length).toBe(2)
    const nginx = b.techStack.find((t) => t.name === 'nginx')!
    expect(nginx.version).toBe('1.20')
    expect(nginx.confidence).toBeCloseTo(0.95)
    expect(b.metadata.status).toBe(200)
    expect(b.metadata.title).toBe('Home')
  })

  it('tracks vector attempts and dedupes repeated payloads', () => {
    const asset = upsertAsset({
      type: 'url',
      value: 'https://example.com/api',
      discoveredBy: 'httpx',
      techStack: [],
      metadata: {},
      confidence: 1,
    })
    const vec = addVector({
      assetId: asset.id,
      class: 'sqli',
      description: 'test',
      rationale: 'unit test',
      likelihood: 0.5,
      evidence: [],
      ttps: ttpsForClass('sqli'),
    })
    recordAttempt(vec.id, {
      payload: "' OR 1=1 --",
      response: { status: 500, latencyMs: 80, bodySnippet: 'SQL syntax error', headers: {} },
      signals: ['error:sql'],
      outcome: 'succeeded',
      reasoning: 'sql error leaked',
    })
    expect(hasAttempted(vec.id, "' OR 1=1 --")).toBe(true)
    expect(hasAttempted(vec.id, "' OR 2=2 --")).toBe(false)
    expect(getCurrentOperation()!.vectors[0].status).toBe('succeeded')
  })

  it('prioritizes vectors by likelihood × asset exploitability', () => {
    const a1 = upsertAsset({
      type: 'url', value: 'https://example.com/a',
      discoveredBy: 'op', techStack: [], metadata: {},
      confidence: 1, exploitability: 0.2,
    })
    const a2 = upsertAsset({
      type: 'url', value: 'https://example.com/b',
      discoveredBy: 'op', techStack: [], metadata: {},
      confidence: 1, exploitability: 0.9,
    })
    addVector({ assetId: a1.id, class: 'xss', description: 'd', rationale: 'r', likelihood: 0.9, evidence: [], ttps: [] })
    addVector({ assetId: a2.id, class: 'sqli', description: 'd', rationale: 'r', likelihood: 0.6, evidence: [], ttps: [] })
    const ranked = prioritizedVectors(5)
    // a2 (high exploitability) should outrank a1 despite lower vector likelihood, because of weighting
    expect(ranked[0].asset?.value).toBe('https://example.com/b')
  })

  it('builds a report with findings, top vectors, ttps and recommendations', () => {
    const asset = upsertAsset({
      type: 'url', value: 'https://example.com/',
      discoveredBy: 'httpx',
      techStack: [{ name: 'Anthropic Claude', confidence: 0.8, source: 'fingerprint', evidence: 'chat' }],
      metadata: {}, confidence: 1, exploitability: 0.5,
    })
    const vec = addVector({
      assetId: asset.id,
      class: 'prompt-injection',
      description: 'd',
      rationale: 'r',
      likelihood: 0.8,
      evidence: [],
      ttps: ttpsForClass('prompt-injection'),
    })
    addFinding({
      severity: 'high',
      title: 'direct prompt injection',
      description: 'canary leaked',
      assetId: asset.id,
      vectorId: vec.id,
      ttps: ttpsForClass('prompt-injection'),
      evidence: ['canary-leaked'],
      remediation: 'isolate instructions',
    })
    const report = buildReport()
    expect(report.counts.assets).toBe(1)
    expect(report.counts.vectors).toBe(1)
    expect(report.counts.findings).toBe(1)
    expect(report.topVectors[0].class).toBe('prompt-injection')
    expect(report.ttps).toContain('AML.T0051')
    // LLM in tech stack triggers the prompt-injection recommendation
    expect(report.recommendedNext.some((r) => /prompt-injection/.test(r))).toBe(true)
  })
})

describe('offensive-ops: MITRE mapping', () => {
  it('maps web vuln classes to T1190', () => {
    expect(ttpsForClass('sqli')).toContain('T1190')
    expect(ttpsForClass('xss')).toContain('T1190')
    expect(ttpsForClass('ssrf')).toContain('T1190')
  })

  it('maps prompt injection to ATLAS techniques', () => {
    expect(ttpsForClass('prompt-injection')).toContain('AML.T0051')
    expect(ttpsForClass('prompt-injection')).toContain('AML.T0051.000')
    expect(ttpsForClass('indirect-prompt-injection')).toContain('AML.T0051.001')
    expect(ttpsForClass('tool-poisoning')).toContain('AML.T0053')
  })

  it('describes known TTPs with framework labels', () => {
    const described = describeTTPs(['T1190', 'AML.T0051', 'UNKNOWN'])
    expect(described[0]).toContain('Exploit Public-Facing Application')
    expect(described[0]).toContain('ATT&CK')
    expect(described[1]).toContain('Prompt Injection')
    expect(described[1]).toContain('ATLAS')
    expect(described[2]).toContain('unknown')
  })
})

describe('offensive-ops: tool dispatcher integration', () => {
  let tmp: string

  beforeEach(() => {
    _resetForTest()
    tmp = mkdtempSync(join(tmpdir(), 'smolerclaw-off-'))
    initOffensiveOps(tmp)
  })

  afterEach(() => {
    _resetForTest()
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects agent tool calls on an unauthorized operation', async () => {
    const { executeOffensiveTool } = await import('../src/tools/offensive-tools')
    const create = await executeOffensiveTool('offensive_op_create', {
      name: 'lab',
      domains: ['example.com'],
    })
    expect(create).toContain('UNAUTHORIZED')

    // The recon tool should refuse because the op is not authorized.
    const res = await executeOffensiveTool('offensive_recon', { target: 'example.com' })
    expect(res).toContain('not authorized')
  })

  it('rejects agent tool calls on out-of-scope targets', async () => {
    const { executeOffensiveTool } = await import('../src/tools/offensive-tools')
    await executeOffensiveTool('offensive_op_create', {
      name: 'lab',
      domains: ['example.com'],
    })
    await executeOffensiveTool('offensive_op_authorize', { justification: 'lab environment' })
    const res = await executeOffensiveTool('offensive_recon', { target: 'evil.com' })
    expect(res).toContain('not in authorized scope')
  })

  it('returns a status snapshot', async () => {
    const { executeOffensiveTool } = await import('../src/tools/offensive-tools')
    await executeOffensiveTool('offensive_op_create', { name: 'lab', domains: ['example.com'] })
    const status = await executeOffensiveTool('offensive_op_status', {})
    expect(status).toContain('Operation: lab')
    expect(status).toContain('Authorized: NO')
  })
})
