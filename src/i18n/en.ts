import type { TranslationDict } from './types'

export const en: TranslationDict = {
  // ─── Web UI ─────────────────────────────────────────────
  'web.title': 'smolerclaw',
  'web.welcome_title': 'Welcome to smolerclaw',
  'web.welcome_desc': 'Your micro AI assistant for Windows. Ask me anything, and I\'ll help you with code, files, system tasks, and more.',
  'web.new_chat': '+ New Chat',
  'web.no_sessions': 'No sessions yet',
  'web.total_cost': 'Total cost:',
  'web.toggle_theme': 'Toggle theme',
  'web.clear_chat': 'Clear chat',
  'web.placeholder': 'Message smolerclaw...',
  'web.input_hint': 'Press Enter to send, Shift+Enter for new line',
  'web.confirm_new_chat': 'Start a new chat?',
  'web.messages_count': '{{count}} messages',
  'web.you': 'You',
  'web.assistant': 'smolerclaw',
  'web.running': 'running',
  'web.complete': 'complete',
  'web.connected': 'Connected to smolerclaw',
  'web.disconnected': 'Disconnected, reconnecting...',
  'web.suggestion_start_title': 'Get started',
  'web.suggestion_start_desc': 'Learn what I can do',
  'web.suggestion_tasks_title': 'View tasks',
  'web.suggestion_tasks_desc': 'See your task list',
  'web.suggestion_system_title': 'System info',
  'web.suggestion_system_desc': 'Get Windows status',
  'web.suggestion_briefing_title': 'Daily briefing',
  'web.suggestion_briefing_desc': 'Start your day',
  'web.suggestion_start_prompt': 'What can you help me with?',
  'web.suggestion_tasks_prompt': 'Show me my recent tasks',
  'web.suggestion_system_prompt': 'Check system status',
  'web.suggestion_briefing_prompt': 'Give me a daily briefing',

  // ─── UI Mode Console ───────────────────────────────────
  'ui.starting_web': 'Starting smolerclaw web UI...',
  'ui.running_at': 'App running at: {{url}}',

  // ─── Session ────────────────────────────────────────────
  'session.no_sessions': 'No sessions found.',
  'session.sessions_title': 'Sessions',
  'session.messages': '{{count}} messages',
  'session.filter': 'filter:',

  // ─── General Labels ─────────────────────────────────────
  'label.you': 'You',
  'label.assistant': 'Claude',

  // ─── Approval ───────────────────────────────────────────
  'approval.prompt': '[y]es / [n]o / [a]ll',
  'approval.approved': 'approved',
  'approval.rejected': 'rejected',
  'approval.approved_all': 'approved all for this session',
  'approval.timeout': 'timeout — auto-rejected',

  // ─── Tools ──────────────────────────────────────────────
  'tool.more_lines': '... ({{count}} more lines)',

  // ─── Plugins ────────────────────────────────────────────
  'plugin.none_loaded': 'No plugins loaded. Add files to {{dir}}',
  'plugin.list_title': 'Plugins:',

  // ─── GWS (Google Workspace) ────────────────────────────
  'gws.gmail': 'Gmail',
  'gws.agenda': 'Calendar',
  'gws.drive': 'Drive',
  'gws.panel_title': 'Google Workspace Dashboard',
  'gws.press_any_key': 'Press any key to return',
  'gws.unread_total': '{{unread}} unread / {{total}} total',
  'gws.events_today': '{{count}} events today',
  'gws.no_events': 'No events scheduled',
  'gws.items': '{{count}} items',
  'gws.no_files': 'No files found',
  'gws.no_emails': 'No emails found.',
  'gws.inbox_clear': 'Inbox clear',
  'gws.no_events_today': 'No events today',
  'gws.no_recent_files': 'No recent files',
  'gws.unread': '{{count}} unread',
  'gws.events': '{{count}} events',
  'gws.recent_files': '{{count}} recent files',
  'gws.briefing_title': 'Google Workspace Briefing',
  'gws.error': 'Error: {{msg}}',
}
