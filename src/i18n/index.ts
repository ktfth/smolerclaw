/**
 * i18n — Internationalization module
 *
 * Usage:
 *   import { initI18n, t } from './i18n'
 *   initI18n(config.language)
 *   console.log(t('web.welcome_title'))  // "Bem-vindo ao smolerclaw"
 */

import type { Locale, TranslationKeys, TranslationParams, TranslationDict } from './types'
import { en } from './en'
import { pt } from './pt'
import { resolveLocale } from './resolve-locale'

export type { Locale, TranslationKeys, TranslationParams, TranslationDict }
export { resolveLocale }

const dictionaries: Record<Locale, TranslationDict> = { en, pt }

let currentLocale: Locale = 'en'
let currentDict: TranslationDict = en

/**
 * Initialize i18n with the configured language.
 * Call once at app startup before any UI rendering.
 */
export function initI18n(language: string): void {
  currentLocale = resolveLocale(language)
  currentDict = dictionaries[currentLocale] || en
}

/**
 * Translate a key, with optional parameter interpolation.
 * Falls back to English if the key is missing in the current locale.
 */
export function t(key: keyof TranslationKeys, params?: TranslationParams): string {
  let value = currentDict[key] || en[key] || key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
    }
  }
  return value
}

/**
 * Get all translations for the current locale.
 * Useful for injecting into HTML templates.
 */
export function getTranslations(): TranslationDict {
  return { ...currentDict }
}

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  currentLocale = locale
  currentDict = dictionaries[locale] || en
}
