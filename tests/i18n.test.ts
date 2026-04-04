import { describe, it, expect } from 'bun:test'
import { initI18n, t, getLocale, setLocale, getTranslations } from '../src/i18n'
import { resolveLocale } from '../src/i18n/resolve-locale'
import { en } from '../src/i18n/en'
import { pt } from '../src/i18n/pt'

describe('i18n', () => {
  describe('resolveLocale', () => {
    it('maps "pt" to pt', () => {
      expect(resolveLocale('pt')).toBe('pt')
    })

    it('maps "pt-BR" to pt', () => {
      expect(resolveLocale('pt-BR')).toBe('pt')
    })

    it('maps "en" to en', () => {
      expect(resolveLocale('en')).toBe('en')
    })

    it('maps unknown to en', () => {
      expect(resolveLocale('xx')).toBe('en')
    })
  })

  describe('initI18n', () => {
    it('initializes with Portuguese', () => {
      initI18n('pt')
      expect(getLocale()).toBe('pt')
    })

    it('initializes with English', () => {
      initI18n('en')
      expect(getLocale()).toBe('en')
    })
  })

  describe('t()', () => {
    it('returns Portuguese for pt locale', () => {
      initI18n('pt')
      expect(t('web.welcome_title')).toBe('Bem-vindo ao smolerclaw')
    })

    it('returns English for en locale', () => {
      initI18n('en')
      expect(t('web.welcome_title')).toBe('Welcome to smolerclaw')
    })

    it('interpolates parameters', () => {
      initI18n('pt')
      expect(t('ui.running_at', { url: 'http://test' })).toBe('App rodando em: http://test')
    })

    it('interpolates multiple parameters', () => {
      initI18n('en')
      expect(t('tool.more_lines', { count: 42 })).toBe('... (42 more lines)')
    })
  })

  describe('setLocale', () => {
    it('switches locale', () => {
      initI18n('en')
      expect(t('web.welcome_title')).toBe('Welcome to smolerclaw')

      setLocale('pt')
      expect(t('web.welcome_title')).toBe('Bem-vindo ao smolerclaw')
    })
  })

  describe('getTranslations', () => {
    it('returns all translations for current locale', () => {
      initI18n('pt')
      const translations = getTranslations()
      expect(translations['web.welcome_title']).toBe('Bem-vindo ao smolerclaw')
      expect(translations['ui.starting_web']).toBe('Iniciando interface web do smolerclaw...')
    })
  })

  describe('translation completeness', () => {
    it('en and pt have the same keys', () => {
      const enKeys = Object.keys(en).sort()
      const ptKeys = Object.keys(pt).sort()
      expect(enKeys).toEqual(ptKeys)
    })

    it('no empty values in en', () => {
      for (const [key, value] of Object.entries(en)) {
        expect(value.length).toBeGreaterThan(0)
      }
    })

    it('no empty values in pt', () => {
      for (const [key, value] of Object.entries(pt)) {
        expect(value.length).toBeGreaterThan(0)
      }
    })
  })
})
