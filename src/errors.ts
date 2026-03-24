/**
 * Translate Anthropic API errors to actionable user messages.
 */
export function humanizeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)

  const status = (err as { status?: number }).status
  const msg = err.message

  // HTTP status-based errors
  if (status) {
    switch (status) {
      case 400:
        if (msg.includes('context_length') || msg.includes('too many tokens')) {
          return 'Message too long for the model\'s context window. Try /clear to start fresh or use a shorter prompt.'
        }
        return `Bad request: ${extractDetail(msg)}`

      case 401:
        return 'Authentication failed. Your subscription token may be expired.\n' +
          'Try: Run `claude` to refresh subscription credentials.'

      case 403:
        return 'Access denied. Your subscription may not have permission for this model.\n' +
          'Try: /model haiku (uses a more accessible model).'

      case 404:
        return `Model not found. The model "${extractModel(msg)}" may not exist or be unavailable.\n` +
          'Try: /model to see available models.'

      case 429:
        return 'Rate limited. Too many requests in a short period.\n' +
          'The request will be retried automatically. If this persists, wait a minute.'

      case 500:
      case 502:
      case 503:
        return 'Anthropic API is temporarily unavailable. Retrying automatically...'

      case 529:
        return 'Anthropic API is overloaded. Retrying with backoff...'
    }
  }

  // Network errors
  const lower = msg.toLowerCase()
  if (lower.includes('econnrefused') || lower.includes('enotfound')) {
    return 'Cannot connect to Anthropic API. Check your internet connection.'
  }
  if (lower.includes('etimedout') || lower.includes('socket hang up')) {
    return 'Connection to Anthropic API timed out. Retrying...'
  }
  if (lower.includes('econnreset')) {
    return 'Connection was reset. This usually recovers automatically.'
  }

  // Subscription-specific
  if (lower.includes('expired') || lower.includes('invalid_api_key')) {
    return 'Your subscription token has expired. Run `claude` to refresh.'
  }

  // Default: return original with prefix
  return msg
}

function extractDetail(msg: string): string {
  // Try to extract the "detail" or "message" field from API error JSON
  try {
    const match = msg.match(/"message"\s*:\s*"([^"]+)"/)
    if (match) return match[1]
  } catch { /* ignore */ }
  return msg.length > 200 ? msg.slice(0, 200) + '...' : msg
}

function extractModel(msg: string): string {
  const match = msg.match(/model[:\s]+"?([a-z0-9-]+)"?/i)
  return match ? match[1] : 'unknown'
}
