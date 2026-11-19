/**
 * Tool classification derived from the catalog declarations. tool-safety
 * consults this; nothing maintains a second list.
 */
import { DOMAIN_TOOLS } from './domain'
import { INTEGRATION_TOOLS } from './integrations'

const CATALOG = [...DOMAIN_TOOLS, ...INTEGRATION_TOOLS]

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  CATALOG.filter((t) => t.readOnly).map((t) => t.schema.name),
)

/** Tools that deliver content to third parties immediately. */
export const SEND_TOOL_NAMES: ReadonlySet<string> = new Set(
  CATALOG.filter((t) => t.sends).map((t) => t.schema.name),
)

/** Every tool the catalog declares, read-only or not. */
export const CATALOG_TOOL_NAMES: ReadonlySet<string> = new Set(CATALOG.map((t) => t.schema.name))
