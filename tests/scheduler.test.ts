import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  initScheduler, stopScheduler,
  listJobs, getJob,
  formatJobList, formatJobDetail,
  parseScheduleTime, parseScheduleDate, parseWeekDay,
} from '../src/scheduler'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Note: Actual Windows Task Scheduler tests require Windows environment
// These tests focus on the pure logic functions that work cross-platform

describe('scheduler', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'smolerclaw-scheduler-test-'))
    initScheduler(tmpDir, () => {}) // no-op notification
  })

  test('initScheduler creates empty state', () => {
    const jobs = listJobs()
    expect(jobs).toEqual([])
  })

  test('initScheduler creates data directory', () => {
    const customDir = join(tmpDir, 'custom-scheduler')
    initScheduler(customDir)
    expect(existsSync(customDir)).toBe(true)
  })

  test('formatJobList handles empty list', () => {
    const result = formatJobList([])
    expect(result).toContain('Nenhum agendamento')
  })

  test('stopScheduler does not throw', () => {
    expect(() => stopScheduler()).not.toThrow()
  })
})

describe('parseScheduleTime', () => {
  test('parses HH:MM format', () => {
    expect(parseScheduleTime('14:00')).toBe('14:00')
    expect(parseScheduleTime('09:30')).toBe('09:30')
    expect(parseScheduleTime('0:00')).toBe('00:00')
    expect(parseScheduleTime('23:59')).toBe('23:59')
  })

  test('parses single digit hour', () => {
    expect(parseScheduleTime('9:00')).toBe('09:00')
    expect(parseScheduleTime('9:30')).toBe('09:30')
  })

  test('parses HHh format (Brazilian)', () => {
    expect(parseScheduleTime('14h')).toBe('14:00')
    expect(parseScheduleTime('9h')).toBe('09:00')
    expect(parseScheduleTime('0h')).toBe('00:00')
  })

  test('parses HHhMM format (Brazilian)', () => {
    expect(parseScheduleTime('14h30')).toBe('14:30')
    expect(parseScheduleTime('9h15')).toBe('09:15')
    expect(parseScheduleTime('23h59')).toBe('23:59')
  })

  test('parses 12-hour format with am/pm', () => {
    expect(parseScheduleTime('2pm')).toBe('14:00')
    expect(parseScheduleTime('2:30pm')).toBe('14:30')
    expect(parseScheduleTime('12pm')).toBe('12:00')
    expect(parseScheduleTime('12am')).toBe('00:00')
    expect(parseScheduleTime('9am')).toBe('09:00')
    expect(parseScheduleTime('9:30am')).toBe('09:30')
  })

  test('handles uppercase', () => {
    expect(parseScheduleTime('2PM')).toBe('14:00')
    expect(parseScheduleTime('9AM')).toBe('09:00')
    expect(parseScheduleTime('14H30')).toBe('14:30')
  })

  test('returns null for invalid time', () => {
    expect(parseScheduleTime('25:00')).toBeNull()
    expect(parseScheduleTime('14:60')).toBeNull()
    expect(parseScheduleTime('hello')).toBeNull()
    expect(parseScheduleTime('')).toBeNull()
    expect(parseScheduleTime('abc')).toBeNull()
  })

  test('returns null for invalid 12-hour format', () => {
    expect(parseScheduleTime('13pm')).toBeNull()  // 13 is invalid for 12h format
  })
})

describe('parseScheduleDate', () => {
  test('parses "hoje"', () => {
    const result = parseScheduleDate('hoje')
    expect(result).toBeTruthy()
    // Result should be in MM/DD/YYYY format (schtasks format)
    const today = new Date()
    const expected = [
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
      String(today.getFullYear()),
    ].join('/')
    expect(result).toBe(expected)
  })

  test('parses "today"', () => {
    const result = parseScheduleDate('today')
    expect(result).toBeTruthy()
  })

  test('parses "amanha"', () => {
    const result = parseScheduleDate('amanha')
    expect(result).toBeTruthy()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const expected = [
      String(tomorrow.getMonth() + 1).padStart(2, '0'),
      String(tomorrow.getDate()).padStart(2, '0'),
      String(tomorrow.getFullYear()),
    ].join('/')
    expect(result).toBe(expected)
  })

  test('parses "amanhã" with accent', () => {
    const result = parseScheduleDate('amanhã')
    expect(result).toBeTruthy()
  })

  test('parses "tomorrow"', () => {
    const result = parseScheduleDate('tomorrow')
    expect(result).toBeTruthy()
  })

  test('parses DD/MM/YYYY format', () => {
    const result = parseScheduleDate('15/04/2026')
    expect(result).toBe('04/15/2026') // Converted to MM/DD/YYYY
  })

  test('parses DD-MM-YYYY format', () => {
    const result = parseScheduleDate('15-04-2026')
    expect(result).toBe('04/15/2026')
  })

  test('parses DD.MM.YYYY format', () => {
    const result = parseScheduleDate('15.04.2026')
    expect(result).toBe('04/15/2026')
  })

  test('parses DD/MM format (assumes current year)', () => {
    const result = parseScheduleDate('15/04')
    expect(result).toBeTruthy()
    const year = new Date().getFullYear()
    expect(result).toBe(`04/15/${year}`)
  })

  test('returns null for invalid date', () => {
    expect(parseScheduleDate('32/01/2026')).toBeNull()  // Invalid day
    expect(parseScheduleDate('01/13/2026')).toBeNull()  // Invalid month
    expect(parseScheduleDate('hello')).toBeNull()
    expect(parseScheduleDate('')).toBeNull()
  })
})

describe('parseWeekDay', () => {
  // Portuguese
  test('parses Portuguese day names', () => {
    expect(parseWeekDay('domingo')).toBe('SUN')
    expect(parseWeekDay('segunda')).toBe('MON')
    expect(parseWeekDay('segunda-feira')).toBe('MON')
    expect(parseWeekDay('terca')).toBe('TUE')
    expect(parseWeekDay('terça')).toBe('TUE')
    expect(parseWeekDay('quarta')).toBe('WED')
    expect(parseWeekDay('quinta')).toBe('THU')
    expect(parseWeekDay('sexta')).toBe('FRI')
    expect(parseWeekDay('sabado')).toBe('SAT')
    expect(parseWeekDay('sábado')).toBe('SAT')
  })

  test('parses Portuguese abbreviations', () => {
    expect(parseWeekDay('dom')).toBe('SUN')
    expect(parseWeekDay('seg')).toBe('MON')
    expect(parseWeekDay('ter')).toBe('TUE')
    expect(parseWeekDay('qua')).toBe('WED')
    expect(parseWeekDay('qui')).toBe('THU')
    expect(parseWeekDay('sex')).toBe('FRI')
    expect(parseWeekDay('sab')).toBe('SAT')
  })

  // English
  test('parses English day names', () => {
    expect(parseWeekDay('sunday')).toBe('SUN')
    expect(parseWeekDay('monday')).toBe('MON')
    expect(parseWeekDay('tuesday')).toBe('TUE')
    expect(parseWeekDay('wednesday')).toBe('WED')
    expect(parseWeekDay('thursday')).toBe('THU')
    expect(parseWeekDay('friday')).toBe('FRI')
    expect(parseWeekDay('saturday')).toBe('SAT')
  })

  test('parses English abbreviations', () => {
    expect(parseWeekDay('sun')).toBe('SUN')
    expect(parseWeekDay('mon')).toBe('MON')
    expect(parseWeekDay('tue')).toBe('TUE')
    expect(parseWeekDay('wed')).toBe('WED')
    expect(parseWeekDay('thu')).toBe('THU')
    expect(parseWeekDay('fri')).toBe('FRI')
    expect(parseWeekDay('sat')).toBe('SAT')
  })

  test('handles case insensitivity', () => {
    expect(parseWeekDay('MONDAY')).toBe('MON')
    expect(parseWeekDay('Segunda')).toBe('MON')
    expect(parseWeekDay('SEXTA')).toBe('FRI')
  })

  test('returns null for invalid day', () => {
    expect(parseWeekDay('notaday')).toBeNull()
    expect(parseWeekDay('')).toBeNull()
    expect(parseWeekDay('abc')).toBeNull()
  })
})

describe('formatJobDetail', () => {
  test('formats job details correctly', () => {
    // Create a mock job object
    const mockJob = {
      id: 'abc12345',
      name: 'Test Meeting',
      scheduleType: 'daily' as const,
      time: '14:00',
      dateOrDay: undefined,
      action: 'toast' as const,
      target: 'Meeting reminder',
      enabled: true,
      taskName: 'Smolerclaw_abc12345',
      createdAt: '2026-03-31T10:00:00.000Z',
      updatedAt: '2026-03-31T10:00:00.000Z',
    }

    const result = formatJobDetail(mockJob)

    expect(result).toContain('Test Meeting')
    expect(result).toContain('abc12345')
    expect(result).toContain('daily')
    expect(result).toContain('14:00')
    expect(result).toContain('toast')
    expect(result).toContain('Meeting reminder')
    expect(result).toContain('ativo')
    expect(result).toContain('Smolerclaw_abc12345')
  })
})
