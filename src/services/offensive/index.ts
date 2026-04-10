/**
 * Offensive Operations — public surface.
 *
 * Exposes the three agents (recon, payload mutation, prompt-injection)
 * and a sequential pipeline that runs them in order and produces the
 * final report required by the spec.
 */

export * from './state'
export * from './mitre'
export { runRecon, type ReconOptions, type ReconReport } from './recon'
export { runPayloadLoop, type PayloadLoopOptions, type PayloadLoopResult } from './payload'
export { runPromptInjection, type PromptInjectOptions, type PromptInjectResult } from './prompt-inject'

import { runRecon, type ReconOptions } from './recon'
import { runPayloadLoop, type PayloadLoopOptions } from './payload'
import { runPromptInjection, type PromptInjectOptions } from './prompt-inject'
import {
  assertInScope,
  buildReport,
  getCurrentOperation,
  logTimeline,
  prioritizedVectors,
  setKillChainPhase,
  type OperationReport,
} from './state'
import { describeTTPs } from './mitre'

export interface PipelineOptions {
  rootTarget: string
  recon?: ReconOptions
  /** Run payload mutation against each inferred vector (capped). */
  runPayloadMutation?: boolean
  /** Only run payload mutation on vectors with this likelihood or higher. */
  payloadLikelihoodFloor?: number
  /** Max payload loops to run. Default 3. */
  maxPayloadLoops?: number
  /** Run prompt injection against any LLM-backed asset. */
  runPromptInjection?: boolean
  /** Overrides for payload mutation (headers, body, etc). */
  payloadOverrides?: Partial<Omit<PayloadLoopOptions, 'target' | 'parameter' | 'vulnClass'>>
  /** Overrides for prompt injection. */
  promptInjectOverrides?: Partial<Omit<PromptInjectOptions, 'target'>>
}

export interface PipelineResult {
  report: OperationReport
  ttpDetails: string[]
  stages: {
    recon: { ran: boolean; summary: string }
    payload: { ran: boolean; summary: string }
    promptInject: { ran: boolean; summary: string }
  }
}

/**
 * Run the full offensive pipeline end-to-end, carrying the shared operation
 * state across every agent. Each stage is optional — by default only recon
 * runs, because payload mutation and prompt injection act on real targets
 * and must be explicitly opted in by the operator.
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const scopeErr = assertInScope(opts.rootTarget)
  if (scopeErr) throw new Error(scopeErr)
  const op = getCurrentOperation()
  if (!op) throw new Error('no active operation')

  logTimeline('operator', 'pipeline:start', opts.rootTarget)
  const stages: PipelineResult['stages'] = {
    recon: { ran: false, summary: '' },
    payload: { ran: false, summary: '' },
    promptInject: { ran: false, summary: '' },
  }

  // ── Stage 1: Recon ────────────────────────────────────
  setKillChainPhase('reconnaissance')
  try {
    const reconResult = await runRecon(opts.rootTarget, opts.recon ?? {})
    stages.recon = {
      ran: true,
      summary: `assets=${reconResult.assetCount}, new vectors=${reconResult.newVectors}, ran=${reconResult.ranSteps.join(',') || 'none'}, skipped=${reconResult.skippedSteps.map((s) => s.step).join(',') || 'none'}`,
    }
  } catch (err) {
    stages.recon = { ran: false, summary: `error: ${err instanceof Error ? err.message : String(err)}` }
  }

  // ── Stage 2: Payload mutation on top vectors ─────────
  if (opts.runPayloadMutation) {
    setKillChainPhase('exploitation')
    const floor = opts.payloadLikelihoodFloor ?? 0.5
    const cap = Math.max(1, Math.min(10, opts.maxPayloadLoops ?? 3))
    const candidates = prioritizedVectors(cap * 2)
      .filter(({ vector }) => vector.likelihood >= floor)
      .filter(({ vector }) => !isLLMClass(vector.class))
      .slice(0, cap)

    const summaries: string[] = []
    for (const { vector, asset } of candidates) {
      if (!asset || asset.type !== 'url') continue
      // We need a parameter to mutate. Default to a reflected-looking query param.
      const u = tryParseUrl(asset.value)
      if (!u) continue
      const paramName = pickParameter(u)
      try {
        const res = await runPayloadLoop({
          target: asset.value,
          parameter: paramName,
          vulnClass: vector.class,
          ...(opts.payloadOverrides ?? {}),
        })
        summaries.push(`${vector.class}:${paramName}@${asset.value} → ${res.status} (${res.attempts} probes)`)
      } catch (err) {
        summaries.push(`${vector.class}@${asset.value} → error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    stages.payload = {
      ran: true,
      summary: summaries.length ? summaries.join(' | ') : 'no eligible vectors',
    }
  }

  // ── Stage 3: Prompt injection on LLM-backed assets ───
  if (opts.runPromptInjection) {
    setKillChainPhase('exploitation')
    const llmAssets = op.assets.filter((a) =>
      a.type === 'url' || a.type === 'endpoint'
    ).filter((a) =>
      a.techStack.some((t) => /llm|openai|claude|anthropic|gpt|bedrock|gemini|mistral/i.test(t.name)) ||
      op.vectors.some((v) => v.assetId === a.id && isLLMClass(v.class))
    )

    const summaries: string[] = []
    for (const asset of llmAssets.slice(0, 3)) {
      try {
        const r = await runPromptInjection({
          target: asset.value,
          ...(opts.promptInjectOverrides ?? {}),
        })
        summaries.push(`${asset.value} → llm=${r.isLLMBacked} findings=${r.findings}`)
      } catch (err) {
        summaries.push(`${asset.value} → error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    stages.promptInject = {
      ran: true,
      summary: summaries.length ? summaries.join(' | ') : 'no LLM-backed assets detected',
    }
  }

  logTimeline('operator', 'pipeline:done', JSON.stringify(stages))
  const report = buildReport()
  return {
    report,
    ttpDetails: describeTTPs(report.ttps),
    stages,
  }
}

// ─── Helpers ───────────────────────────────────────────────

function isLLMClass(cls: string): boolean {
  return cls === 'prompt-injection' || cls === 'indirect-prompt-injection' || cls === 'tool-poisoning'
}

function tryParseUrl(value: string): URL | null {
  try { return new URL(value) } catch { return null }
}

function pickParameter(u: URL): string {
  const first = u.searchParams.keys().next().value
  return first ?? 'q'
}
