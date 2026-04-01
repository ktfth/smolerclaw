import { ClaudeProvider } from '../claude'
import { OpenAICompatProvider } from '../openai-provider'
import { parseModelString } from '../providers'
import { refreshAuth, type AuthResult } from '../auth'
import type { ToolApprovalMode } from '../types'

// Common provider interface for both Claude and OpenAI-compatible
export type AnyProvider = {
  chat: ClaudeProvider['chat']
  setModel: (m: string) => void
  setApprovalCallback?: ClaudeProvider['setApprovalCallback']
  setAutoApproveAll?: ClaudeProvider['setAutoApproveAll']
}

/**
 * Mutable holder for auth state — allows the provider's refresh callback
 * and the /refresh command to update the same reference.
 */
export interface AuthHolder {
  auth: AuthResult
}

export function initProvider(
  authHolder: AuthHolder,
  model: string,
  maxTokens: number,
  toolApproval: ToolApprovalMode,
): AnyProvider {
  const { provider: providerType, model: providerModel } = parseModelString(model)

  if (providerType === 'openai' || providerType === 'ollama') {
    return new OpenAICompatProvider(providerType, providerModel, maxTokens)
  }

  const claudeProvider = new ClaudeProvider(authHolder.auth.token, model, maxTokens, toolApproval)

  // Auto-refresh credentials on 401 so the session survives token expiration
  claudeProvider.setAuthRefresh(() => {
    const freshAuth = refreshAuth()
    if (freshAuth && freshAuth.token !== authHolder.auth.token) {
      authHolder.auth = freshAuth
      claudeProvider.updateToken(freshAuth.token)
      return true
    }
    return false
  })

  return claudeProvider
}
