/**
 * Security utilities: SSRF guard, path traversal prevention, input validation.
 */
import { existsSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export function guardPath(filePath: string): string | null {
  const resolved = resolve(filePath)
  const cwd = process.cwd()
  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    return `Error: path outside working directory is not permitted: ${resolved}`
  }
  // Follow symlinks and re-check containment
  try {
    if (existsSync(resolved)) {
      const real = realpathSync(resolved)
      if (real !== cwd && !real.startsWith(cwd + sep)) {
        return `Error: symlink target is outside working directory: ${real}`
      }
    }
  } catch {
    // File doesn't exist yet (write_file creating new file) — that's OK
  }
  return null
}

/** Validate that a required string input is present and non-empty */
export function requireString(input: Record<string, unknown>, key: string): string | null {
  const val = input[key]
  if (typeof val !== 'string' || val.trim().length === 0) {
    return `Error: '${key}' is required and must be a non-empty string.`
  }
  return null
}

/**
 * Block SSRF: reject URLs pointing to private/internal networks.
 */
export function checkSsrf(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr)
    const host = parsed.hostname.toLowerCase()

    // Block non-HTTP schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Error: protocol ${parsed.protocol} is not allowed.`
    }

    // Block private/reserved hostnames
    const blockedHostnames = [
      'localhost', '127.0.0.1', '::1', '0.0.0.0',
      '::ffff:127.0.0.1', '::ffff:0.0.0.0',
    ]
    if (blockedHostnames.includes(host)) {
      return 'Error: requests to localhost are blocked for security.'
    }
    if (host.endsWith('.local') || host.endsWith('.internal')) {
      return 'Error: requests to internal hostnames are blocked.'
    }
    // Block cloud metadata endpoints
    if (host === 'metadata.google.internal' || host === 'metadata.gcp.internal') {
      return 'Error: requests to cloud metadata endpoints are blocked.'
    }

    // Block private IP ranges (decimal notation)
    const parts = host.split('.').map(Number)
    if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 10) return 'Error: requests to private IPs (10.x) are blocked.'
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 'Error: requests to private IPs (172.16-31.x) are blocked.'
      if (parts[0] === 192 && parts[1] === 168) return 'Error: requests to private IPs (192.168.x) are blocked.'
      if (parts[0] === 169 && parts[1] === 254) return 'Error: requests to link-local/metadata IPs are blocked.'
      if (parts[0] === 0) return 'Error: requests to 0.x IPs are blocked.'
    }

    // Block IPv6-mapped IPv4 (::ffff:x.x.x.x)
    if (host.startsWith('::ffff:') || host.startsWith('[::ffff:')) {
      return 'Error: requests to IPv6-mapped IPv4 addresses are blocked.'
    }
  } catch {
    return 'Error: invalid URL.'
  }
  return null
}

/**
 * Strip HTML tags and extract readable text.
 * Simple heuristic — not a full parser.
 */
export function stripHtml(html: string): string {
  let text = html
    // Remove script and style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<(br|hr)[^>]*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}
