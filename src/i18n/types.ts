/**
 * i18n type definitions
 */

export type Locale = 'en' | 'pt'

export interface TranslationParams {
  [key: string]: string | number
}

export interface TranslationKeys {
  // ─── Desktop Menus ──────────────────────────────────────
  'desktop.about': string
  'desktop.settings': string
  'desktop.quit': string
  'desktop.chat': string
  'desktop.new_chat': string
  'desktop.clear_chat': string
  'desktop.edit': string
  'desktop.undo': string
  'desktop.redo': string
  'desktop.cut': string
  'desktop.copy': string
  'desktop.paste': string
  'desktop.select_all': string
  'desktop.view': string
  'desktop.toggle_theme': string
  'desktop.actual_size': string
  'desktop.zoom_in': string
  'desktop.zoom_out': string
  'desktop.dev_tools': string
  'desktop.window': string
  'desktop.minimize': string
  'desktop.zoom': string
  'desktop.close': string
  'desktop.help': string
  'desktop.documentation': string
  'desktop.report_issue': string
  'desktop.not_available': string
  'desktop.opening_browser': string

  // ─── Web UI ─────────────────────────────────────────────
  'web.title': string
  'web.welcome_title': string
  'web.welcome_desc': string
  'web.new_chat': string
  'web.no_sessions': string
  'web.total_cost': string
  'web.toggle_theme': string
  'web.clear_chat': string
  'web.placeholder': string
  'web.input_hint': string
  'web.confirm_new_chat': string
  'web.messages_count': string
  'web.you': string
  'web.assistant': string
  'web.running': string
  'web.complete': string
  'web.connected': string
  'web.disconnected': string
  'web.suggestion_start_title': string
  'web.suggestion_start_desc': string
  'web.suggestion_tasks_title': string
  'web.suggestion_tasks_desc': string
  'web.suggestion_system_title': string
  'web.suggestion_system_desc': string
  'web.suggestion_briefing_title': string
  'web.suggestion_briefing_desc': string
  'web.suggestion_start_prompt': string
  'web.suggestion_tasks_prompt': string
  'web.suggestion_system_prompt': string
  'web.suggestion_briefing_prompt': string

  // ─── UI Mode Console ───────────────────────────────────
  'ui.starting_web': string
  'ui.starting_desktop': string
  'ui.running_at': string

  // ─── Session ────────────────────────────────────────────
  'session.no_sessions': string
  'session.sessions_title': string
  'session.messages': string
  'session.filter': string

  // ─── General Labels ─────────────────────────────────────
  'label.you': string
  'label.assistant': string

  // ─── Approval ───────────────────────────────────────────
  'approval.prompt': string
  'approval.approved': string
  'approval.rejected': string
  'approval.approved_all': string
  'approval.timeout': string

  // ─── Tools ──────────────────────────────────────────────
  'tool.more_lines': string

  // ─── Plugins ────────────────────────────────────────────
  'plugin.none_loaded': string
  'plugin.list_title': string
}

export type TranslationDict = Record<keyof TranslationKeys, string>
