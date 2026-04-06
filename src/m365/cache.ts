/**
 * M365 Cache — TTL-based in-memory cache for M365 CLI results.
 *
 * Reduces redundant m365 CLI calls by caching results per command.
 * Each resource type has its own TTL (emails: 2min, calendar: 5min, etc.).
 */

import type { CacheEntry } from './types'
import { CACHE_TTL } from './types'

// ─── State ──────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>()

// ─── Public API ─────────────────────────────────────────────

/**
 * Get a cached value if it exists and hasn't expired.
 */
export function cacheGet<T>(key: string): T | null {
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
 *
 * @param key - Cache key (typically the m365 command string)
 * @param data - Data to cache
 * @param resourceType - Resource type for TTL lookup (e.g., 'emails', 'calendar')
 * @param ttlOverride - Optional TTL override in milliseconds
 */
export function cacheSet<T>(
  key: string,
  data: T,
  resourceType: string,
  ttlOverride?: number,
): void {
  const ttl = ttlOverride ?? CACHE_TTL[resourceType] ?? 5 * 60_000
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttl,
    key,
  })
}

/**
 * Invalidate a specific cache entry.
 */
export function cacheInvalidate(key: string): boolean {
  return cache.delete(key)
}

/**
 * Invalidate all entries matching a prefix (e.g., 'outlook' clears all Outlook cache).
 */
export function cacheInvalidatePrefix(prefix: string): number {
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
export function cacheClear(): void {
  cache.clear()
}

/**
 * Get cache stats for debugging.
 */
export function cacheStats(): { size: number; keys: string[] } {
  // Prune expired entries first
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
