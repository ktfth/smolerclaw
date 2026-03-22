const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529])

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 1000

interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, waitMs: number, reason: string) => void
}

/**
 * Retry a function with exponential backoff.
 * Only retries on transient HTTP errors (429, 5xx).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      if (opts.signal?.aborted) throw err
      if (attempt >= maxRetries) throw err
      if (!isRetryable(err)) throw err

      const retryAfter = extractRetryAfter(err)
      const waitMs = retryAfter ?? baseDelay * Math.pow(2, attempt)

      const reason = err instanceof Error ? err.message : String(err)
      opts.onRetry?.(attempt + 1, waitMs, reason)

      await sleep(waitMs, opts.signal)
    }
  }

  throw lastError
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  // Anthropic SDK errors include a status property
  const status = (err as { status?: number }).status
  if (status && RETRYABLE_STATUS.has(status)) return true

  // Network errors
  const msg = err.message.toLowerCase()
  if (msg.includes('econnreset') || msg.includes('econnrefused')) return true
  if (msg.includes('etimedout') || msg.includes('socket hang up')) return true
  if (msg.includes('overloaded')) return true

  return false
}

function extractRetryAfter(err: unknown): number | null {
  const headers = (err as { headers?: Record<string, string> }).headers
  if (!headers) return null

  const retryAfter = headers['retry-after']
  if (!retryAfter) return null

  const seconds = Number(retryAfter)
  if (!isNaN(seconds) && seconds > 0) {
    // Cap at 60 seconds to prevent hour-long sleeps
    return Math.min(seconds, 60) * 1000
  }

  return null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }, { once: true })
  })
}
