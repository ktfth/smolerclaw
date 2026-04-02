import type { TranslationDict } from './types'

export const pt: TranslationDict = {
  // ─── Desktop Menus ──────────────────────────────────────
  'desktop.about': 'Sobre o smolerclaw',
  'desktop.settings': 'Configurações...',
  'desktop.quit': 'Sair',
  'desktop.chat': 'Conversa',
  'desktop.new_chat': 'Nova Conversa',
  'desktop.clear_chat': 'Limpar Conversa',
  'desktop.edit': 'Editar',
  'desktop.undo': 'Desfazer',
  'desktop.redo': 'Refazer',
  'desktop.cut': 'Recortar',
  'desktop.copy': 'Copiar',
  'desktop.paste': 'Colar',
  'desktop.select_all': 'Selecionar Tudo',
  'desktop.view': 'Visualizar',
  'desktop.toggle_theme': 'Alternar Tema',
  'desktop.actual_size': 'Tamanho Real',
  'desktop.zoom_in': 'Aumentar Zoom',
  'desktop.zoom_out': 'Diminuir Zoom',
  'desktop.dev_tools': 'Ferramentas do Desenvolvedor',
  'desktop.window': 'Janela',
  'desktop.minimize': 'Minimizar',
  'desktop.zoom': 'Zoom',
  'desktop.close': 'Fechar',
  'desktop.help': 'Ajuda',
  'desktop.documentation': 'Documentação',
  'desktop.report_issue': 'Reportar Problema',
  'desktop.not_available': 'Electrobun não disponível.',
  'desktop.opening_browser': 'Abrindo no navegador padrão: {{url}}',

  // ─── Web UI ─────────────────────────────────────────────
  'web.title': 'smolerclaw',
  'web.welcome_title': 'Bem-vindo ao smolerclaw',
  'web.welcome_desc': 'Seu micro assistente de IA para Windows. Pergunte qualquer coisa — ajudo com código, arquivos, tarefas do sistema e muito mais.',
  'web.new_chat': '+ Nova Conversa',
  'web.no_sessions': 'Nenhuma sessão ainda',
  'web.total_cost': 'Custo total:',
  'web.toggle_theme': 'Alternar tema',
  'web.clear_chat': 'Limpar conversa',
  'web.placeholder': 'Mensagem para o smolerclaw...',
  'web.input_hint': 'Enter para enviar, Shift+Enter para nova linha',
  'web.confirm_new_chat': 'Iniciar nova conversa?',
  'web.messages_count': '{{count}} mensagens',
  'web.you': 'Você',
  'web.assistant': 'smolerclaw',
  'web.running': 'executando',
  'web.complete': 'concluído',
  'web.connected': 'Conectado ao smolerclaw',
  'web.disconnected': 'Desconectado, reconectando...',
  'web.suggestion_start_title': 'Começar',
  'web.suggestion_start_desc': 'Saiba o que eu posso fazer',
  'web.suggestion_tasks_title': 'Ver tarefas',
  'web.suggestion_tasks_desc': 'Veja sua lista de tarefas',
  'web.suggestion_system_title': 'Info do sistema',
  'web.suggestion_system_desc': 'Status do Windows',
  'web.suggestion_briefing_title': 'Briefing diário',
  'web.suggestion_briefing_desc': 'Comece seu dia',
  'web.suggestion_start_prompt': 'O que você pode fazer por mim?',
  'web.suggestion_tasks_prompt': 'Mostre minhas tarefas recentes',
  'web.suggestion_system_prompt': 'Verifique o status do sistema',
  'web.suggestion_briefing_prompt': 'Me dê um briefing diário',

  // ─── UI Mode Console ───────────────────────────────────
  'ui.starting_web': 'Iniciando interface web do smolerclaw...',
  'ui.starting_desktop': 'Iniciando app desktop do smolerclaw...',
  'ui.running_at': 'App rodando em: {{url}}',

  // ─── Session ────────────────────────────────────────────
  'session.no_sessions': 'Nenhuma sessão encontrada.',
  'session.sessions_title': 'Sessões',
  'session.messages': '{{count}} mensagens',
  'session.filter': 'filtro:',

  // ─── General Labels ─────────────────────────────────────
  'label.you': 'Você',
  'label.assistant': 'Claude',

  // ─── Approval ───────────────────────────────────────────
  'approval.prompt': '[s]im / [n]ão / [t]odos',
  'approval.approved': 'aprovado',
  'approval.rejected': 'rejeitado',
  'approval.approved_all': 'aprovado tudo para esta sessão',
  'approval.timeout': 'tempo esgotado — rejeitado automaticamente',

  // ─── Tools ──────────────────────────────────────────────
  'tool.more_lines': '... ({{count}} linhas a mais)',

  // ─── Plugins ────────────────────────────────────────────
  'plugin.none_loaded': 'Nenhum plugin carregado. Adicione arquivos em {{dir}}',
  'plugin.list_title': 'Plugins:',
}
