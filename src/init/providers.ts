import { ClaudeProvider } from '../claude'
import { CodexProvider } from '../codex-provider'
import { OpenAIAgentsProvider } from '../openai-agents-provider'
import { OpenAICompatProvider } from '../openai-provider'
import { refreshAuthForProvider, resolveAuthForModel, type AuthResult } from '../auth'
import { assistantNameForProvider, parseModelString, type ProviderType } from '../providers'
import type { ApprovalCallback } from '../approval'
import type { ToolApprovalMode } from '../types'

type ProviderLike = {
  readonly name: string
  chat: ClaudeProvider['chat']
  setModel: (m: string) => void
  setApprovalMode?: (mode: ToolApprovalMode) => void
  setApprovalCallback?: (cb: ApprovalCallback) => void
  setAutoApproveAll?: (value: boolean) => void
  setConversationKey?: (key: string) => void
  updateToken?: (token: string) => void
}

export interface AnyProvider {
  readonly name: string
  chat: ClaudeProvider['chat']
  setModel: (m: string) => void
  setApprovalCallback: (cb: ApprovalCallback) => void
  setAutoApproveAll: (value: boolean) => void
  setConversationKey: (key: string) => void
  getProviderType: () => ProviderType
  getAssistantLabel: () => string
  getCurrentModel: () => string
  supportsAutoRefresh: () => boolean
  syncAuth: (auth: AuthResult | null) => void
}

/**
 * Mutable holder for auth state — allows the provider's refresh callback
 * and the /refresh command to update the same reference.
 */
export interface AuthHolder {
  auth: AuthResult | null
}

export class ProviderManager implements AnyProvider {
  private provider: ProviderLike
  private providerType: ProviderType
  private approvalCallback: ApprovalCallback | null = null
  private autoApproveAll = false
  private conversationKey = 'default'
  private assistantLabel: string

  constructor(
    private authHolder: AuthHolder,
    private model: string,
    private maxTokens: number,
    private toolApproval: ToolApprovalMode,
  ) {
    const created = this.createProvider(model)
    this.provider = created.provider
    this.providerType = created.providerType
    this.assistantLabel = assistantNameForProvider(created.providerType)
    this.applyRuntimeState()
  }

  get name(): string {
    return this.provider.name
  }

  getProviderType(): ProviderType {
    return this.providerType
  }

  getAssistantLabel(): string {
    return this.assistantLabel
  }

  getCurrentModel(): string {
    return this.model
  }

  supportsAutoRefresh(): boolean {
    return this.providerType === 'anthropic'
  }

  syncAuth(auth: AuthResult | null): void {
    this.authHolder.auth = auth
    if (this.providerType === 'anthropic' && auth?.token && this.provider.updateToken) {
      this.provider.updateToken(auth.token)
    }
  }

  setModel(model: string): void {
    const next = this.createProvider(model)
    this.model = model
    this.provider = next.provider
    this.providerType = next.providerType
    this.assistantLabel = assistantNameForProvider(next.providerType)
    this.applyRuntimeState()
  }

  setApprovalCallback(cb: ApprovalCallback): void {
    this.approvalCallback = cb
    this.provider.setApprovalCallback?.(cb)
  }

  setAutoApproveAll(value: boolean): void {
    this.autoApproveAll = value
    this.provider.setAutoApproveAll?.(value)
  }

  setConversationKey(key: string): void {
    this.conversationKey = key
    this.provider.setConversationKey?.(key)
  }

  async *chat(...args: Parameters<ClaudeProvider['chat']>): ReturnType<ClaudeProvider['chat']> {
    yield* this.provider.chat(...args)
  }

  private applyRuntimeState(): void {
    this.provider.setApprovalMode?.(this.toolApproval)
    if (this.approvalCallback) {
      this.provider.setApprovalCallback?.(this.approvalCallback)
    }
    this.provider.setAutoApproveAll?.(this.autoApproveAll)
    this.provider.setConversationKey?.(this.conversationKey)
  }

  private createProvider(model: string): { provider: ProviderLike; providerType: ProviderType } {
    const auth = resolveAuthForModel(model)
    this.authHolder.auth = auth

    const { provider: providerType, model: providerModel } = parseModelString(model)

    if (providerType === 'ollama') {
      return {
        provider: new OpenAICompatProvider(providerType, providerModel, this.maxTokens),
        providerType,
      }
    }

    if (providerType === 'codex') {
      return {
        provider: new CodexProvider(providerModel, this.maxTokens, this.toolApproval),
        providerType,
      }
    }

    if (providerType === 'openai') {
      if (!auth?.token) {
        throw new Error('OpenAI auth token not available.')
      }
      return {
        provider: new OpenAIAgentsProvider(auth.token, providerModel, this.maxTokens, this.toolApproval),
        providerType,
      }
    }

    if (!auth?.token) {
      throw new Error('Claude auth token not available.')
    }

    const claudeProvider = new ClaudeProvider(auth.token, providerModel, this.maxTokens, this.toolApproval)
    claudeProvider.setAuthRefresh(() => {
      const freshAuth = refreshAuthForProvider('anthropic')
      if (freshAuth?.token && freshAuth.token !== this.authHolder.auth?.token) {
        this.syncAuth(freshAuth)
        return true
      }
      return false
    })

    return {
      provider: claudeProvider,
      providerType,
    }
  }
}

export function initProvider(
  authHolder: AuthHolder,
  model: string,
  maxTokens: number,
  toolApproval: ToolApprovalMode,
): AnyProvider {
  return new ProviderManager(authHolder, model, maxTokens, toolApproval)
}
