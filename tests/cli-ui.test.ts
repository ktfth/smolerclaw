import { describe, it, expect } from 'bun:test'
import { parseArgs } from '../src/cli'

describe('CLI UI mode parsing', () => {
  describe('ui command', () => {
    it('parses "ui" command', () => {
      const args = parseArgs(['ui'])
      expect(args.uiMode).toBe('web')
    })

    it('parses "ui" with port', () => {
      const args = parseArgs(['ui', '--port', '8080'])
      expect(args.uiMode).toBe('web')
      expect(args.port).toBe(8080)
    })

    it('parses "ui" with model', () => {
      const args = parseArgs(['ui', '-m', 'opus'])
      expect(args.uiMode).toBe('web')
      expect(args.model).toBe('opus')
    })
  })

  describe('desktop command', () => {
    it('parses "desktop" command', () => {
      const args = parseArgs(['desktop'])
      expect(args.uiMode).toBe('desktop')
    })

    it('parses "desktop" with port', () => {
      const args = parseArgs(['desktop', '--port', '9000'])
      expect(args.uiMode).toBe('desktop')
      expect(args.port).toBe(9000)
    })

    it('parses "desktop" with no-tools', () => {
      const args = parseArgs(['desktop', '--no-tools'])
      expect(args.uiMode).toBe('desktop')
      expect(args.noTools).toBe(true)
    })
  })

  describe('default mode', () => {
    it('defaults to tui mode', () => {
      const args = parseArgs([])
      expect(args.uiMode).toBe('tui')
    })

    it('defaults to tui with prompt', () => {
      const args = parseArgs(['hello', 'world'])
      expect(args.uiMode).toBe('tui')
      expect(args.prompt).toBe('hello world')
    })
  })

  describe('port validation', () => {
    it('accepts valid port', () => {
      const args = parseArgs(['ui', '--port', '3000'])
      expect(args.port).toBe(3000)
    })

    it('accepts port 1', () => {
      const args = parseArgs(['ui', '--port', '1'])
      expect(args.port).toBe(1)
    })

    it('accepts port 65535', () => {
      const args = parseArgs(['ui', '--port', '65535'])
      expect(args.port).toBe(65535)
    })
  })

  describe('combined options', () => {
    it('parses all options together', () => {
      const args = parseArgs(['ui', '-m', 'haiku', '--port', '4000', '-s', 'test', '--no-tools'])
      expect(args.uiMode).toBe('web')
      expect(args.model).toBe('haiku')
      expect(args.port).toBe(4000)
      expect(args.session).toBe('test')
      expect(args.noTools).toBe(true)
    })
  })
})
