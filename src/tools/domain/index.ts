/**
 * Personal-management catalog: every tool here returns a structured
 * ToolResult and is safe to expose to an external agent (MCP/CLI).
 */
import type { CatalogEntry } from '../../core/result'
import { TASK_TOOLS } from './tasks'
import { SCHEDULER_TOOLS } from './scheduler'
import { PEOPLE_TOOLS } from './people'
import { MEMO_TOOLS } from './memos'
import { BOOKMARK_TOOLS } from './bookmarks'
import { MATERIAL_TOOLS } from './materials'
import { FINANCE_TOOLS } from './finance'
import { PROJECT_TOOLS } from './projects'
import { COMMS_TOOLS } from './comms'
import { VAULT_TOOLS } from './vault'

export const DOMAIN_TOOLS: readonly CatalogEntry[] = [
  ...TASK_TOOLS,
  ...SCHEDULER_TOOLS,
  ...PEOPLE_TOOLS,
  ...MEMO_TOOLS,
  ...BOOKMARK_TOOLS,
  ...MATERIAL_TOOLS,
  ...FINANCE_TOOLS,
  ...PROJECT_TOOLS,
  ...COMMS_TOOLS,
  ...VAULT_TOOLS,
]
