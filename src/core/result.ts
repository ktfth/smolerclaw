import type Anthropic from '@anthropic-ai/sdk'

/**
 * Structured tool outcome. Success is a field, never inferred from the text,
 * so a failure written in any language is still a failure.
 */
export type ToolResult =
  | { readonly ok: true; readonly text: string; readonly data?: unknown }
  | { readonly ok: false; readonly text: string }

export function ok(text: string, data?: unknown): ToolResult {
  return data === undefined ? { ok: true, text } : { ok: true, text, data }
}

export function fail(text: string): ToolResult {
  return { ok: false, text }
}

/** Text shown to a chat model: failures keep the conventional "Error:" prefix. */
export function toChatText(result: ToolResult): string {
  if (result.ok) return result.text
  return result.text.startsWith('Error:') ? result.text : `Error: ${result.text}`
}

/**
 * Adapter for handlers that still return plain strings (file tools,
 * integrations, plugins). Those follow the "Error:" convention, so the prefix
 * is the contract there; everything native to the catalog returns ToolResult.
 */
export function fromLegacyText(text: string): ToolResult {
  return text.startsWith('Error:') ? fail(text) : ok(text)
}

export type ToolInput = Readonly<Record<string, unknown>>
export type ToolHandler = (input: ToolInput) => ToolResult | Promise<ToolResult>

export interface CatalogEntry {
  readonly schema: Anthropic.Tool
  readonly run: ToolHandler
  /** True when the tool only reads state. Declared next to the handler, never guessed. */
  readonly readOnly: boolean
}

/**
 * Pair schemas with handlers. Throws at module load if either side has a name
 * the other lacks (or a read-only name matches nothing), so a schema can never
 * be advertised without a handler and the read-only list cannot go stale.
 */
export function bindTools(
  schemas: readonly CatalogEntry['schema'][],
  handlers: Readonly<Record<string, ToolHandler>>,
  readOnly: readonly string[] = [],
): CatalogEntry[] {
  const names = new Set(schemas.map((s) => s.name))
  const orphans = [
    ...schemas.filter((s) => !handlers[s.name]).map((s) => `schema without handler: ${s.name}`),
    ...Object.keys(handlers).filter((n) => !names.has(n)).map((n) => `handler without schema: ${n}`),
    ...readOnly.filter((n) => !names.has(n)).map((n) => `read-only name without schema: ${n}`),
  ]
  if (orphans.length > 0) throw new Error(`Tool catalog mismatch: ${orphans.join(', ')}`)
  const reads = new Set(readOnly)
  return schemas.map((schema) => ({ schema, run: handlers[schema.name], readOnly: reads.has(schema.name) }))
}

/** Read a required, non-blank string field. */
export function requireText(input: ToolInput, field: string): string | null {
  const value = input[field]
  return typeof value === 'string' && value.trim() ? value : null
}

export function optionalText(input: ToolInput, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function optionalStrings(input: ToolInput, field: string): string[] | undefined {
  const value = input[field]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
}
