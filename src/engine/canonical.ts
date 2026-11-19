import { createHash } from 'node:crypto'

/**
 * Serialize a value as JSON with object keys sorted recursively.
 * The same logical input always yields the same string, which makes
 * hashes and audit records reproducible across runs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

/** SHA-256 hex digest of the canonical JSON form. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, sortKeys(record[key])]),
  )
}
