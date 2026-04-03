/**
 * i18n type definitions
 */

export type Locale = 'en' | 'pt'

export interface TranslationParams {
  [key: string]: string | number
}

export interface TranslationKeys {
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
