/**
 * Microsoft 365 and Google Workspace tools. Their handlers return strings
 * that follow the "Error:" convention, adapted here to ToolResult.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { fromLegacyText, type CatalogEntry } from '../core/result'
import { executeM365Tool, M365_TOOLS } from '../m365'
import { executeGwsTool, GWS_TOOLS } from '../gws'

type Executor = (name: string, input: Record<string, unknown>) => Promise<string | null>

const READ_ONLY: ReadonlySet<string> = new Set([
  'm365_list_emails', 'm365_read_email', 'm365_list_events', 'm365_list_todos', 'm365_list_files', 'm365_briefing',
  'gws_list_emails', 'gws_read_email', 'gws_list_events', 'gws_list_files', 'gws_search_files', 'gws_briefing',
])

function adapt(schemas: readonly Anthropic.Tool[], execute: Executor): CatalogEntry[] {
  return schemas.map((schema) => ({
    schema,
    readOnly: READ_ONLY.has(schema.name),
    run: async (input) =>
      fromLegacyText((await execute(schema.name, { ...input })) ?? `Error: unknown tool "${schema.name}"`),
  }))
}

export const INTEGRATION_TOOLS: readonly CatalogEntry[] = [
  ...adapt(M365_TOOLS, executeM365Tool),
  ...adapt(GWS_TOOLS, executeGwsTool),
]

const unknownReads = [...READ_ONLY].filter((n) => !INTEGRATION_TOOLS.some((t) => t.schema.name === n))
if (unknownReads.length > 0) throw new Error(`Unknown read-only integration tools: ${unknownReads.join(', ')}`)
