import { describe, test, expect } from 'bun:test'
import { getKnownApps, getDateTimeInfo } from '../src/windows'

describe('windows', () => {
  test('getKnownApps returns app list', () => {
    const apps = getKnownApps()
    expect(apps.length).toBeGreaterThan(0)
    expect(apps).toContain('excel')
    expect(apps).toContain('outlook')
    expect(apps).toContain('notepad')
    expect(apps).toContain('vscode')
  })

  test('getDateTimeInfo returns formatted date', async () => {
    const info = await getDateTimeInfo()
    expect(info).toBeTruthy()
    expect(info).toContain('Semana')
    expect(info).toContain('Status:')
  })
})
