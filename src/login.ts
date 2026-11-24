import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { resolveAuthForProvider } from './auth'
import { defaultModelForProvider } from './models'
import { MANUAL_MODEL, parseModelString, assistantNameForProvider, type ProviderType } from './providers'

export type LoginProvider = Extract<ProviderType, 'anthropic' | 'codex'>

const STARTUP_CHOICES: Record<string, LoginProvider> = {
  '2': 'anthropic', claude: 'anthropic',
  '3': 'codex', codex: 'codex',
}

export async function promptStartupProviderSelection(currentModel: string): Promise<string | null> {
  const current = parseModelString(currentModel).provider

  output.write('\nSessão inicial\n')
  output.write(`Atual: ${assistantNameForProvider(current)} (${currentModel})\n`)
  output.write(`1. Continuar atual\n`)
  output.write(`2. Claude via API key (ANTHROPIC_API_KEY) [${getProviderStatusLabel('anthropic')}]\n`)
  output.write(`3. Entrar/usar Codex [${getProviderStatusLabel('codex')}]\n`)
  output.write(`4. Modo manual (sem modelo, sem chave): comandos, /run e /diario\n`)
  output.write('   Assinatura Claude: use o Claude Code com o MCP (smolerclaw mcp).\n')

  const rl = createInterface({ input, output })
  // On EOF (Ctrl+D, closed pipe) a pending question never settles; treat it as "keep current".
  const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')))
  try {
    // A failed login explains why and asks again instead of crashing the process.
    for (;;) {
      const answer = (await Promise.race([rl.question('Escolha [Enter=atual]: '), closed])).trim().toLowerCase()
      if (answer === '4' || answer === MANUAL_MODEL) return MANUAL_MODEL
      const provider = STARTUP_CHOICES[answer]
      if (!provider) return currentModel
      try {
        await loginWithProvider(provider)
        return defaultModelForProvider(provider)
      } catch (err) {
        output.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`)
      }
    }
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

  if (provider === 'anthropic') {
    // API-key auth has no interactive login; resolve again to surface the setup message.
    resolveAuthForProvider(provider)
    return
  }

  const proc = Bun.spawn(['codex', 'login'], {
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
