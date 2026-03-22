import { describe, test, expect } from 'bun:test'
import { parseArgs } from '../src/cli'

describe('parseArgs', () => {
  test('defaults', () => {
    const args = parseArgs([])
    expect(args.help).toBe(false)
    expect(args.version).toBe(false)
    expect(args.print).toBe(false)
    expect(args.noTools).toBe(false)
    expect(args.model).toBeUndefined()
    expect(args.prompt).toBeUndefined()
  })

  test('--help', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
  })

  test('--version', () => {
    expect(parseArgs(['-v']).version).toBe(true)
    expect(parseArgs(['--version']).version).toBe(true)
  })

  test('--model', () => {
    expect(parseArgs(['-m', 'sonnet']).model).toBe('sonnet')
    expect(parseArgs(['--model', 'haiku']).model).toBe('haiku')
  })

  test('--session', () => {
    expect(parseArgs(['-s', 'work']).session).toBe('work')
  })

  test('--print', () => {
    expect(parseArgs(['-p']).print).toBe(true)
    expect(parseArgs(['--print']).print).toBe(true)
  })

  test('--no-tools', () => {
    expect(parseArgs(['--no-tools']).noTools).toBe(true)
  })

  test('positional args become prompt', () => {
    expect(parseArgs(['hello', 'world']).prompt).toBe('hello world')
  })

  test('mixed flags and positional', () => {
    const args = parseArgs(['-m', 'opus', '-p', 'explain', 'this'])
    expect(args.model).toBe('opus')
    expect(args.print).toBe(true)
    expect(args.prompt).toBe('explain this')
  })
})
