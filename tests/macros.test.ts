import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initMacros,
  getMacro,
  listMacros,
  listAllMacros,
  createMacro,
  updateMacro,
  deleteMacro,
  formatMacroList,
  formatMacroDetail,
  getMacroNames,
} from '../src/macros'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('macros', () => {
  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'smolerclaw-macro-'))
    initMacros(tmpDir)
  })

  describe('initialization', () => {
    test('seeds default macros on first init', () => {
      const macros = listAllMacros()
      expect(macros.length).toBeGreaterThan(0)
      // Check for some expected defaults
      expect(macros.some((m) => m.name === 'vscode')).toBe(true)
      expect(macros.some((m) => m.name === 'terminal')).toBe(true)
      expect(macros.some((m) => m.name === 'github')).toBe(true)
    })
  })

  describe('getMacro', () => {
    test('finds macro by exact name', () => {
      const macro = getMacro('vscode')
      expect(macro).not.toBeNull()
      expect(macro?.name).toBe('vscode')
    })

    test('finds macro by partial name', () => {
      const macro = getMacro('vsc')
      expect(macro).not.toBeNull()
      expect(macro?.name).toBe('vscode')
    })

    test('finds macro by id', () => {
      const macros = listAllMacros()
      const first = macros[0]
      const found = getMacro(first.id)
      expect(found).not.toBeNull()
      expect(found?.id).toBe(first.id)
    })

    test('returns null for unknown macro', () => {
      expect(getMacro('nonexistent')).toBeNull()
    })
  })

  describe('listMacros', () => {
    test('returns only enabled macros', () => {
      const macros = listMacros()
      expect(macros.every((m) => m.enabled)).toBe(true)
    })

    test('filters by tag', () => {
      const devMacros = listMacros('dev')
      expect(devMacros.length).toBeGreaterThan(0)
      expect(devMacros.every((m) => m.tags.includes('dev'))).toBe(true)
    })

    test('returns empty for unknown tag', () => {
      const macros = listMacros('nonexistent-tag')
      expect(macros.length).toBe(0)
    })
  })

  describe('listAllMacros', () => {
    test('returns all macros including disabled', () => {
      const macro = getMacro('vscode')
      if (macro) {
        updateMacro(macro.id, { enabled: false })
      }
      const enabledMacros = listMacros()
      const allMacros = listAllMacros()
      expect(allMacros.length).toBeGreaterThan(enabledMacros.length)
    })
  })

  describe('createMacro', () => {
    test('creates a new macro', () => {
      const macro = createMacro('myapp', 'My custom app', 'open_app', 'notepad')
      expect(macro.id).toBeTruthy()
      expect(macro.name).toBe('myapp')
      expect(macro.description).toBe('My custom app')
      expect(macro.action).toBe('open_app')
      expect(macro.target).toBe('notepad')
      expect(macro.enabled).toBe(true)
    })

    test('creates macro with optional fields', () => {
      const macro = createMacro('myurl', 'My URL', 'open_url', 'https://example.com', {
        icon: '🔗',
        tags: ['web', 'favorite'],
      })
      expect(macro.icon).toBe('🔗')
      expect(macro.tags).toContain('web')
      expect(macro.tags).toContain('favorite')
    })

    test('replaces existing macro with same name', () => {
      createMacro('testmacro', 'First version', 'open_app', 'notepad')
      createMacro('testmacro', 'Second version', 'open_url', 'https://example.com')

      const all = listAllMacros()
      const matches = all.filter((m) => m.name === 'testmacro')
      expect(matches.length).toBe(1)
      expect(matches[0].description).toBe('Second version')
      expect(matches[0].action).toBe('open_url')
    })

    test('normalizes name to lowercase', () => {
      const macro = createMacro('MyMacro', 'Test', 'open_app', 'notepad')
      expect(macro.name).toBe('mymacro')
    })

    test('normalizes tags to lowercase', () => {
      const macro = createMacro('test', 'Test', 'open_app', 'notepad', {
        tags: ['DEV', 'Work'],
      })
      expect(macro.tags).toContain('dev')
      expect(macro.tags).toContain('work')
    })
  })

  describe('updateMacro', () => {
    test('updates macro description', () => {
      const macro = createMacro('test', 'Original', 'open_app', 'notepad')
      const updated = updateMacro(macro.id, { description: 'Updated' })
      expect(updated?.description).toBe('Updated')
    })

    test('updates macro enabled status', () => {
      const macro = createMacro('test', 'Test', 'open_app', 'notepad')
      expect(macro.enabled).toBe(true)

      const disabled = updateMacro(macro.id, { enabled: false })
      expect(disabled?.enabled).toBe(false)

      const reenabled = updateMacro(macro.id, { enabled: true })
      expect(reenabled?.enabled).toBe(true)
    })

    test('updates macro tags', () => {
      const macro = createMacro('test', 'Test', 'open_app', 'notepad')
      const updated = updateMacro(macro.id, { tags: ['new', 'tags'] })
      expect(updated?.tags).toContain('new')
      expect(updated?.tags).toContain('tags')
    })

    test('returns null for unknown macro', () => {
      expect(updateMacro('nonexistent', { description: 'test' })).toBeNull()
    })
  })

  describe('deleteMacro', () => {
    test('deletes existing macro', () => {
      const macro = createMacro('todelete', 'To delete', 'open_app', 'notepad')
      const countBefore = listAllMacros().length
      expect(deleteMacro(macro.id)).toBe(true)
      expect(listAllMacros().length).toBe(countBefore - 1)
    })

    test('deletes by name', () => {
      createMacro('deletebyname', 'Test', 'open_app', 'notepad')
      expect(deleteMacro('deletebyname')).toBe(true)
      expect(getMacro('deletebyname')).toBeNull()
    })

    test('returns false for unknown macro', () => {
      expect(deleteMacro('nonexistent')).toBe(false)
    })
  })

  describe('formatMacroList', () => {
    test('formats list with macros', () => {
      const text = formatMacroList(listMacros())
      expect(text).toContain('Macros')
      expect(text).toContain('vscode')
    })

    test('shows empty message for empty list', () => {
      expect(formatMacroList([])).toContain('Nenhum macro')
    })

    test('groups by tag', () => {
      const text = formatMacroList(listMacros())
      expect(text).toContain('[dev]')
    })

    test('shows usage hint', () => {
      const text = formatMacroList(listMacros())
      expect(text).toContain('/macro')
    })
  })

  describe('formatMacroDetail', () => {
    test('shows macro details', () => {
      const macro = getMacro('vscode')
      if (!macro) throw new Error('Expected vscode macro')

      const text = formatMacroDetail(macro)
      expect(text).toContain('vscode')
      expect(text).toContain('open_app')
      expect(text).toContain('Macro')
    })

    test('shows tags', () => {
      const macro = createMacro('tagged', 'With tags', 'open_app', 'notepad', {
        tags: ['tag1', 'tag2'],
      })
      const text = formatMacroDetail(macro)
      expect(text).toContain('#tag1')
      expect(text).toContain('#tag2')
    })

    test('shows icon', () => {
      const macro = createMacro('withicon', 'With icon', 'open_app', 'notepad', {
        icon: '🚀',
      })
      const text = formatMacroDetail(macro)
      expect(text).toContain('🚀')
    })
  })

  describe('getMacroNames', () => {
    test('returns names of enabled macros', () => {
      const names = getMacroNames()
      expect(names).toContain('vscode')
      expect(names).toContain('terminal')
    })

    test('excludes disabled macros', () => {
      const macro = createMacro('disabled', 'Disabled macro', 'open_app', 'notepad')
      updateMacro(macro.id, { enabled: false })

      const names = getMacroNames()
      expect(names).not.toContain('disabled')
    })
  })

  describe('macro actions', () => {
    test('open_app macro has correct action', () => {
      const macro = createMacro('app', 'App', 'open_app', 'notepad')
      expect(macro.action).toBe('open_app')
      expect(macro.target).toBe('notepad')
    })

    test('open_url macro has correct action', () => {
      const macro = createMacro('url', 'URL', 'open_url', 'https://example.com')
      expect(macro.action).toBe('open_url')
      expect(macro.target).toBe('https://example.com')
    })

    test('open_file macro has correct action', () => {
      const macro = createMacro('file', 'File', 'open_file', 'C:\\test.txt')
      expect(macro.action).toBe('open_file')
      expect(macro.target).toBe('C:\\test.txt')
    })

    test('run_command macro has correct action', () => {
      const macro = createMacro('cmd', 'Command', 'run_command', 'Get-Process')
      expect(macro.action).toBe('run_command')
      expect(macro.target).toBe('Get-Process')
    })
  })
})
