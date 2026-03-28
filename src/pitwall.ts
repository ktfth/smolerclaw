/**
 * Pit Wall — performance benchmarking and regression detection.
 *
 * Captures execution metrics for local scripts:
 *   - Wall-clock time via Bun.nanoseconds() (nanosecond precision)
 *   - Child process peak memory via OS-level queries
 *   - Parent-side CPU overhead via process.cpuUsage()
 *
 * Compares against saved baselines and alerts on regressions > 10%.
 *
 * Integrates with:
 *   - vault.ts for atomic persistence + checksum tracking
 *   - platform.ts for cross-platform shell detection
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { atomicWriteFile } from './vault'
import { getShell, IS_WINDOWS } from './platform'

// ─── Types ──────────────────────────────────────────────────

export interface PerfMetrics {
  durationNs: number          // wall-clock time in nanoseconds (Bun.nanoseconds)
  peakMemoryBytes: number     // child process peak working set (OS-level)
  cpuUserUs: number           // parent-side user CPU in microseconds
  cpuSystemUs: number         // parent-side system CPU in microseconds
}

export interface PerfSpread {
  min: number
  max: number
  median: number
  stddev: number
}

export interface PerfBaseline {
  scriptKey: string
  metrics: PerfMetrics
  spread: PerfSpread | null   // null for single-run baselines
  createdAt: string
  updatedAt: string
  runs: number
  tags: string[]
}

export interface PerfRun {
  scriptKey: string
  command: string
  metrics: PerfMetrics
  spread: PerfSpread | null
  exitCode: number
  stderr: string              // last 2KB of stderr for diagnostics
  timestamp: string
  iterations: number
}

export interface RegressionAlert {
  metric: string
  baselineValue: number
  currentValue: number
  deltaPercent: number        // positive = regression (slower/more)
  absoluteDelta: number       // absolute difference in original units
  severity: 'ok' | 'warning' | 'regression'
}

export interface PerfReport {
  run: PerfRun
  baseline: PerfBaseline | null
  alerts: RegressionAlert[]
  hasRegression: boolean
  markdown: string
}

interface PitwallStore {
  baselines: PerfBaseline[]
  version: number
}

// ─── Constants ──────────────────────────────────────────────

const PITWALL_VERSION = 2
const BASELINES_FILE = 'pitwall-baselines.json'
const REGRESSION_THRESHOLD = 0.10   // 10%
const WARNING_THRESHOLD = 0.05      // 5%
const NOISE_FLOOR_NS = 5_000_000    // 5ms — deltas below this are noise, not regressions
const NOISE_FLOOR_BYTES = 512_000   // 500KB — memory jitter below this is noise
const MAX_STDERR_BYTES = 2048
const BENCHMARK_TIMEOUT_MS = 120_000

// ─── State ──────────────────────────────────────────────────

let _dataDir = ''
let _baselines: PerfBaseline[] = []

// ─── Init ───────────────────────────────────────────────────

export function initPitwall(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  loadBaselines()
}

// ─── Benchmark ──────────────────────────────────────────────

interface RawRunResult {
  durationNs: number
  peakMemoryBytes: number
  cpuUserUs: number
  cpuSystemUs: number
  exitCode: number
  stderr: string
}

/**
 * Execute a single benchmark run.
 * Wall-clock: Bun.nanoseconds(). Memory: OS-level child peak working set.
 */
async function runOnce(
  command: string,
  cwd: string,
): Promise<RawRunResult> {
  const shell = getShell()
  const args = [...shell, command]

  const cpuBefore = process.cpuUsage()
  const startNs = Bun.nanoseconds()

  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
  })

  const timer = setTimeout(() => proc.kill(), BENCHMARK_TIMEOUT_MS)

  // Capture child peak memory while process is still alive
  const pid = proc.pid
  const memoryPromise = getChildPeakMemory(pid)

  const [, stderrRaw] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)

  const endNs = Bun.nanoseconds()
  const cpuDelta = process.cpuUsage(cpuBefore)

  const peakMemory = await memoryPromise

  const stderr = stderrRaw.length > MAX_STDERR_BYTES
    ? `...${stderrRaw.slice(-MAX_STDERR_BYTES)}`
    : stderrRaw

  return {
    durationNs: endNs - startNs,
    peakMemoryBytes: peakMemory,
    cpuUserUs: cpuDelta.user,
    cpuSystemUs: cpuDelta.system,
    exitCode,
    stderr: stderr.trim(),
  }
}

/**
 * Benchmark a command with optional multi-run averaging and warmup.
 */
export async function benchmark(
  command: string,
  opts: {
    scriptKey?: string
    cwd?: string
    iterations?: number
    warmup?: boolean
  } = {},
): Promise<PerfRun> {
  const cwd = opts.cwd || process.cwd()
  const iterations = Math.min(Math.max(opts.iterations || 1, 1), 10)
  const key = opts.scriptKey || deriveKey(command)

  // Optional warmup run (discarded)
  if (opts.warmup && iterations > 1) {
    await runOnce(command, cwd)
  }

  const results: RawRunResult[] = []
  for (let i = 0; i < iterations; i++) {
    results.push(await runOnce(command, cwd))
  }

  // Use the last run's exit code and stderr (most representative)
  const lastResult = results[results.length - 1]

  // Aggregate metrics
  const durations = results.map((r) => r.durationNs)
  const metrics: PerfMetrics = {
    durationNs: median(durations),
    peakMemoryBytes: Math.max(...results.map((r) => r.peakMemoryBytes)),
    cpuUserUs: median(results.map((r) => r.cpuUserUs)),
    cpuSystemUs: median(results.map((r) => r.cpuSystemUs)),
  }

  const spread: PerfSpread | null = iterations > 1
    ? {
        min: Math.min(...durations),
        max: Math.max(...durations),
        median: metrics.durationNs,
        stddev: stddev(durations),
      }
    : null

  return {
    scriptKey: key,
    command,
    metrics,
    spread,
    exitCode: lastResult.exitCode,
    stderr: lastResult.stderr,
    timestamp: new Date().toISOString(),
    iterations,
  }
}

// ─── Child Memory (OS-level) ────────────────────────────────

/**
 * Attempt to read the child process's peak working set from the OS.
 * Falls back to parent RSS delta if OS query fails.
 * The child may already have exited, so this is best-effort.
 */
async function getChildPeakMemory(pid: number): Promise<number> {
  try {
    if (IS_WINDOWS) {
      // PowerShell: Get-Process peak working set (may fail if process already exited)
      const cmd = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PeakWorkingSet64`
      const proc = Bun.spawn(
        ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const timer = setTimeout(() => proc.kill(), 5_000)
      const stdout = await new Response(proc.stdout).text()
      await proc.exited
      clearTimeout(timer)
      const bytes = parseInt(stdout.trim(), 10)
      if (!isNaN(bytes) && bytes > 0) return bytes
    } else {
      // Linux/macOS: read /proc/pid/status for VmPeak (Linux only)
      const statusPath = `/proc/${pid}/status`
      if (existsSync(statusPath)) {
        const content = readFileSync(statusPath, 'utf-8')
        const match = content.match(/VmPeak:\s+(\d+)\s+kB/)
        if (match) return parseInt(match[1], 10) * 1024
      }
    }
  } catch {
    // best effort — child likely already exited
  }

  // Fallback: parent RSS snapshot (less accurate but always available)
  return process.memoryUsage().rss
}

// ─── Baseline Management ────────────────────────────────────

export function saveBaseline(run: PerfRun, tags: string[] = []): PerfBaseline {
  const existing = _baselines.find((b) => b.scriptKey === run.scriptKey)
  const now = new Date().toISOString()

  if (existing) {
    const totalRuns = existing.runs + 1
    const blended: PerfMetrics = {
      durationNs: Math.round(
        (existing.metrics.durationNs * existing.runs + run.metrics.durationNs) / totalRuns,
      ),
      peakMemoryBytes: Math.round(
        (existing.metrics.peakMemoryBytes * existing.runs + run.metrics.peakMemoryBytes) / totalRuns,
      ),
      cpuUserUs: Math.round(
        (existing.metrics.cpuUserUs * existing.runs + run.metrics.cpuUserUs) / totalRuns,
      ),
      cpuSystemUs: Math.round(
        (existing.metrics.cpuSystemUs * existing.runs + run.metrics.cpuSystemUs) / totalRuns,
      ),
    }

    const updated: PerfBaseline = {
      ...existing,
      metrics: blended,
      spread: run.spread || existing.spread,
      updatedAt: now,
      runs: totalRuns,
      tags: [...new Set([...existing.tags, ...tags])],
    }

    _baselines = _baselines.map((b) =>
      b.scriptKey === run.scriptKey ? updated : b,
    )
    persistBaselines()
    return updated
  }

  const baseline: PerfBaseline = {
    scriptKey: run.scriptKey,
    metrics: { ...run.metrics },
    spread: run.spread,
    createdAt: now,
    updatedAt: now,
    runs: 1,
    tags,
  }
  _baselines = [..._baselines, baseline]
  persistBaselines()
  return baseline
}

export function getBaseline(scriptKey: string): PerfBaseline | null {
  return _baselines.find((b) => b.scriptKey === scriptKey) || null
}

export function listBaselines(): PerfBaseline[] {
  return [..._baselines].sort((a, b) => a.scriptKey.localeCompare(b.scriptKey))
}

export function removeBaseline(scriptKey: string): boolean {
  const idx = _baselines.findIndex((b) => b.scriptKey === scriptKey)
  if (idx === -1) return false
  _baselines = [..._baselines.slice(0, idx), ..._baselines.slice(idx + 1)]
  persistBaselines()
  return true
}

export function resetBaseline(run: PerfRun, tags: string[] = []): PerfBaseline {
  removeBaseline(run.scriptKey)
  const now = new Date().toISOString()
  const baseline: PerfBaseline = {
    scriptKey: run.scriptKey,
    metrics: { ...run.metrics },
    spread: run.spread,
    createdAt: now,
    updatedAt: now,
    runs: 1,
    tags,
  }
  _baselines = [..._baselines, baseline]
  persistBaselines()
  return baseline
}

// ─── Regression Detection ───────────────────────────────────

export function compareToBaseline(run: PerfRun): PerfReport {
  const baseline = getBaseline(run.scriptKey)
  const alerts: RegressionAlert[] = []

  if (baseline) {
    alerts.push(
      checkRegression('duration', baseline.metrics.durationNs, run.metrics.durationNs, NOISE_FLOOR_NS),
      checkRegression('memory', baseline.metrics.peakMemoryBytes, run.metrics.peakMemoryBytes, NOISE_FLOOR_BYTES),
      checkRegression('cpu_user', baseline.metrics.cpuUserUs, run.metrics.cpuUserUs, 0),
      checkRegression('cpu_system', baseline.metrics.cpuSystemUs, run.metrics.cpuSystemUs, 0),
    )
  }

  const hasRegression = alerts.some((a) => a.severity === 'regression')
  const markdown = formatReport(run, baseline, alerts, hasRegression)

  return { run, baseline, alerts, hasRegression, markdown }
}

function checkRegression(
  metric: string,
  baselineValue: number,
  currentValue: number,
  noiseFloor: number,
): RegressionAlert {
  const absoluteDelta = currentValue - baselineValue

  // If baseline is zero or delta is below noise floor, skip
  if (baselineValue === 0 || Math.abs(absoluteDelta) < noiseFloor) {
    return { metric, baselineValue, currentValue, deltaPercent: 0, absoluteDelta, severity: 'ok' }
  }

  const delta = absoluteDelta / baselineValue
  let severity: RegressionAlert['severity'] = 'ok'

  if (delta > REGRESSION_THRESHOLD) {
    severity = 'regression'
  } else if (delta > WARNING_THRESHOLD) {
    severity = 'warning'
  }

  return {
    metric,
    baselineValue,
    currentValue,
    deltaPercent: Math.round(delta * 10000) / 100,
    absoluteDelta,
    severity,
  }
}

// ─── Formatting ─────────────────────────────────────────────

function formatNs(ns: number): string {
  if (ns < 1_000) return `${ns}ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}us`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`
  return `${(ns / 1_000_000_000).toFixed(3)}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

function formatUs(us: number): string {
  if (us < 1_000) return `${us}us`
  if (us < 1_000_000) return `${(us / 1_000).toFixed(2)}ms`
  return `${(us / 1_000_000).toFixed(2)}s`
}

function severityIcon(severity: RegressionAlert['severity']): string {
  switch (severity) {
    case 'ok': return '[OK]'
    case 'warning': return '[!]'
    case 'regression': return '[REGRESSAO]'
  }
}

function metricLabel(metric: string): string {
  switch (metric) {
    case 'duration': return 'Duracao'
    case 'memory': return 'Memoria (peak)'
    case 'cpu_user': return 'CPU (user)'
    case 'cpu_system': return 'CPU (sys)'
    default: return metric
  }
}

function formatReport(
  run: PerfRun,
  baseline: PerfBaseline | null,
  alerts: RegressionAlert[],
  hasRegression: boolean,
): string {
  const lines: string[] = []

  // Header
  if (hasRegression) {
    lines.push('=== PIT WALL: REGRESSAO DETECTADA ===')
  } else {
    lines.push('=== Pit Wall: Relatorio de Performance ===')
  }
  lines.push(`Script: ${run.scriptKey}`)
  lines.push(`Comando: ${run.command}`)
  lines.push(`Execucoes: ${run.iterations}`)

  if (run.exitCode !== 0) {
    lines.push(`Exit code: ${run.exitCode} (FALHA)`)
  }
  lines.push('')

  // Current metrics
  lines.push('--- Metricas Atuais ---')
  lines.push(`  Duracao:     ${formatNs(run.metrics.durationNs)}`)
  lines.push(`  Memoria:     ${formatBytes(run.metrics.peakMemoryBytes)}`)
  lines.push(`  CPU (user):  ${formatUs(run.metrics.cpuUserUs)}`)
  lines.push(`  CPU (sys):   ${formatUs(run.metrics.cpuSystemUs)}`)

  if (run.spread) {
    lines.push('')
    lines.push('--- Dispersao ---')
    lines.push(`  Min:     ${formatNs(run.spread.min)}`)
    lines.push(`  Max:     ${formatNs(run.spread.max)}`)
    lines.push(`  Mediana: ${formatNs(run.spread.median)}`)
    lines.push(`  Stddev:  ${formatNs(run.spread.stddev)}`)
    const cv = run.spread.median > 0
      ? ((run.spread.stddev / run.spread.median) * 100).toFixed(1)
      : '0'
    lines.push(`  CV:      ${cv}%`)
    if (parseFloat(cv) > 15) {
      lines.push('  (!) Alta variancia — resultados podem ser instáveis')
    }
  }

  if (run.exitCode !== 0 && run.stderr) {
    lines.push('')
    lines.push('--- Stderr ---')
    lines.push(run.stderr.slice(0, 500))
  }
  lines.push('')

  if (!baseline) {
    lines.push('Nenhum baseline salvo para este script.')
    lines.push('Use pitwall_save_baseline para definir o baseline atual.')
    return lines.join('\n')
  }

  // Baseline comparison
  lines.push(`--- Baseline (${baseline.runs} run${baseline.runs > 1 ? 's' : ''}, atualizado ${formatAge(baseline.updatedAt)}) ---`)
  lines.push(`  Duracao:     ${formatNs(baseline.metrics.durationNs)}`)
  lines.push(`  Memoria:     ${formatBytes(baseline.metrics.peakMemoryBytes)}`)
  lines.push(`  CPU (user):  ${formatUs(baseline.metrics.cpuUserUs)}`)
  lines.push(`  CPU (sys):   ${formatUs(baseline.metrics.cpuSystemUs)}`)
  lines.push('')

  // Delta analysis
  lines.push('--- Comparacao ---')
  for (const alert of alerts) {
    const sign = alert.deltaPercent >= 0 ? '+' : ''
    const label = metricLabel(alert.metric)
    lines.push(`  ${severityIcon(alert.severity)} ${label}: ${sign}${alert.deltaPercent}%`)
  }
  lines.push('')

  if (hasRegression) {
    lines.push('*** ALERTA: Regressao de performance > 10% detectada! ***')
    lines.push('Revise as mudancas recentes no codigo.')
  } else if (alerts.some((a) => a.severity === 'warning')) {
    lines.push('Atencao: algumas metricas estao proximas do limite (5-10%).')
  } else {
    lines.push('Performance dentro do esperado.')
  }

  return lines.join('\n')
}

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `ha ${mins}min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `ha ${hours}h`
  const days = Math.floor(hours / 24)
  return `ha ${days}d`
}

export function formatBaselineList(baselines: PerfBaseline[]): string {
  if (baselines.length === 0) return 'Nenhum baseline salvo no Pit Wall.'

  const lines: string[] = ['=== Pit Wall: Baselines ===', '']
  for (const b of baselines) {
    const tags = b.tags.length > 0 ? ` [${b.tags.join(', ')}]` : ''
    const age = formatAge(b.updatedAt)
    lines.push(`  ${b.scriptKey}`)
    lines.push(`    Duracao: ${formatNs(b.metrics.durationNs)}  |  Memoria: ${formatBytes(b.metrics.peakMemoryBytes)}  |  ${b.runs} runs  |  ${age}${tags}`)
    if (b.spread) {
      const cv = b.spread.median > 0
        ? ((b.spread.stddev / b.spread.median) * 100).toFixed(1)
        : '0'
      lines.push(`    Spread: ${formatNs(b.spread.min)} ~ ${formatNs(b.spread.max)} (CV ${cv}%)`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ─── Statistics ─────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const avg = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1)
  return Math.round(Math.sqrt(variance))
}

function deriveKey(command: string): string {
  // Extract a readable key from a command like "bun run build" → "build"
  const parts = command.trim().split(/\s+/)

  // Handle "bun run X", "npm run X", "yarn X" patterns
  if (parts.length >= 3 && ['bun', 'npm', 'yarn', 'pnpm'].includes(parts[0]) && parts[1] === 'run') {
    return parts[2]
  }
  if (parts.length >= 2 && ['bun', 'npm', 'yarn', 'pnpm'].includes(parts[0])) {
    return parts[1]
  }

  return basename(parts[0])
}

// ─── Persistence ────────────────────────────────────────────

function loadBaselines(): void {
  const file = join(_dataDir, BASELINES_FILE)
  if (!existsSync(file)) {
    _baselines = []
    return
  }
  try {
    const data: PitwallStore = JSON.parse(readFileSync(file, 'utf-8'))
    // Accept both v1 (legacy) and v2 baselines
    if (data.version !== PITWALL_VERSION && data.version !== 1) {
      _baselines = []
      return
    }
    _baselines = (data.baselines || []).map(migrateBaseline)
  } catch {
    _baselines = []
  }
}

/** Migrate v1 baselines (with durationMs) to v2 (without). */
function migrateBaseline(b: PerfBaseline & { metrics: PerfMetrics & { durationMs?: number } }): PerfBaseline {
  const { durationMs: _, ...cleanMetrics } = b.metrics as PerfMetrics & { durationMs?: number }
  return {
    ...b,
    metrics: cleanMetrics as PerfMetrics,
    spread: b.spread || null,
  }
}

function persistBaselines(): void {
  if (!_dataDir) return
  const file = join(_dataDir, BASELINES_FILE)
  const store: PitwallStore = { baselines: _baselines, version: PITWALL_VERSION }
  atomicWriteFile(file, JSON.stringify(store, null, 2))
}
