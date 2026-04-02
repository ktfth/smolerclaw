import type { Locale } from './types'

/**
 * Resolve a configured language string to a supported Locale.
 * When 'auto', detects from OS environment.
 */
export function resolveLocale(configured: string): Locale {
  if (configured !== 'auto') {
    return mapToLocale(configured)
  }

  // Try Intl first (works in Bun/Node/browsers)
  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale
    if (intlLocale) {
      const mapped = mapToLocale(intlLocale)
      if (mapped !== 'en') return mapped
    }
  } catch { /* fallthrough */ }

  // Fall back to environment variables (Linux/macOS/WSL)
  const envLang = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || ''
  if (envLang) {
    return mapToLocale(envLang)
  }

  return 'en'
}

function mapToLocale(raw: string): Locale {
  const lower = raw.toLowerCase().replace(/_/g, '-')

  if (lower.startsWith('pt')) return 'pt'

  return 'en'
}
