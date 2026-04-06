/**
 * GWS Cache — TTL-based in-memory cache for GWS CLI results.
 *
 * Reduces redundant gws CLI calls by caching results per command.
 * Each resource type has its own TTL (gmail: 2min, calendar: 5min, etc.).
 */

import type { GwsCacheEntry } from './types'
import { GWS_CACHE_TTL } from './types'

// ─── State ──────────────────────────────────────────────────

const cache = new Map<string, GwsCacheEntry>()

// ─── Public API ─────────────────────────────────────────────

/**
 * Get a cached value if it exists and hasn't expired.
 */
export function gwsCacheGet<T>(key: string): T | null {
  const entry = cache.get(key)
  if (!entry) return null

  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }

  return entry.data as T
}

/**
 * Store a value in cache with TTL based on resource type.
 */
export function gwsCacheSet<T>(
  key: string,
  data: T,
  resourceType: string,
  ttlOverride?: number,
): void {
  const ttl = ttlOverride ?? GWS_CACHE_TTL[resourceType] ?? 5 * 60_000
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttl,
    key,
  })
}

/**
 * Invalidate all entries matching a prefix.
 */
export function gwsCacheInvalidatePrefix(prefix: string): number {
  let count = 0
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
      count++
    }
  }
  return count
}

/**
 * Clear the entire cache.
 */
export function gwsCacheClear(): void {
  cache.clear()
}

/**
 * Get cache stats for debugging.
 */
export function gwsCacheStats(): { size: number; keys: string[] } {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) {
      cache.delete(key)
    }
  }

  return {
    size: cache.size,
    keys: [...cache.keys()],
  }
}
