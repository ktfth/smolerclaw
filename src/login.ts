import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { resolveAuthForProvider } from './auth'
import { defaultModelForProvider } from './models'
import { parseModelString, assistantNameForProvider, type ProviderType } from './providers'

export type LoginProvider = Extract<ProviderType, 'anthropic' | 'codex'>

export async function promptStartupProviderSelection(currentModel: string): Promise<string | null> {
  const current = parseModelString(currentModel).provider
  const claudeStatus = getProviderStatusLabel('anthropic')
  const codexStatus = getProviderStatusLabel('codex')

  output.write('\nSessao inicial\n')
  output.write(`Atual: ${assistantNameForProvider(current)} (${currentModel})\n`)
  output.write(`1. Continuar atual\n`)
  output.write(`2. Entrar/usar Claude [${claudeStatus}]\n`)
  output.write(`3. Entrar/usar Codex [${codexStatus}]\n`)

  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question('Escolha [Enter=atual]: ')).trim().toLowerCase()

    if (!answer || answer === '1') return currentModel
    if (answer === '2' || answer === 'claude') {
      await loginWithProvider('anthropic')
      return defaultModelForProvider('anthropic')
    }
    if (answer === '3' || answer === 'codex') {
      await loginWithProvider('codex')
      return defaultModelForProvider('codex')
    }

    return currentModel
  } finally {
    rl.close()
  }
}

export async function loginWithProvider(provider: LoginProvider, force = false): Promise<void> {
  if (!force) {
    try {
      if (resolveAuthForProvider(provider)) {
        return
      }
    } catch {
      // fall through to interactive login
    }
  }

  const cmd = provider === 'anthropic'
    ? ['claude', 'auth', 'login']
    : ['codex', 'login']

  const proc = Bun.spawn(cmd, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`${assistantNameForProvider(provider)} login failed with exit code ${code}.`)
  }

  try {
    resolveAuthForProvider(provider)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

function getProviderStatusLabel(provider: LoginProvider): string {
  try {
    const auth = resolveAuthForProvider(provider)
    return auth ? 'conectado' : 'ausente'
  } catch {
    return 'ausente'
  }
}
