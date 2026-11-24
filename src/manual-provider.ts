/**
 * Manual mode: the TUI runs with no model and no credentials. Free text is
 * not sent anywhere; the reply explains how to work by commands instead.
 */
import type { ChatEvent, Message } from './types'

export const MANUAL_GUIDE = [
  'Modo manual: sem modelo de IA, nada é enviado para fora.',
  'Use comandos:',
  '  /tarefa <texto>   /tarefas   /feito <id ou título>   /memo <texto>   /notas',
  '  /tools [filtro]              lista o que o motor sabe fazer',
  '  /run <tool> {json}           executa pelo motor (auditado, vai para o Diário e o vault)',
  '  /simular <tool> {json}       valida sem executar',
  '  /diario [AAAA-MM-DD]         o que foi criado ou alterado no dia',
  'Para conversar com um modelo: defina ANTHROPIC_API_KEY e use /model.',
].join('\n')

export class ManualProvider {
  readonly name = 'manual'

  setModel(_model: string): void {}

  async *chat(_messages: Message[], _systemPrompt: string, _enableTools = true): AsyncGenerator<ChatEvent> {
    yield { type: 'text', text: MANUAL_GUIDE }
    yield { type: 'done' }
  }
}
