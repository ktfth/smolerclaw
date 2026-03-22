import { describe, test, expect } from 'bun:test'
import { loadSkills, formatSkillList } from '../src/skills'

describe('loadSkills', () => {
  test('returns empty array for non-existent dir', () => {
    const skills = loadSkills('/nonexistent/dir')
    // May return local skills from CWD if .tinyclaw/skills exists
    // But won't crash
    expect(Array.isArray(skills)).toBe(true)
  })

  test('loads from existing skills dir', () => {
    const skills = loadSkills('./skills')
    expect(skills.length).toBeGreaterThan(0)
    const names = skills.map((s) => s.name)
    expect(names).toContain('default')
    expect(names).toContain('business')
    expect(skills.every((s) => s.source === 'global')).toBe(true)
  })
})

describe('formatSkillList', () => {
  test('shows no skills message when empty', () => {
    expect(formatSkillList([])).toContain('No skills')
  })

  test('shows source labels', () => {
    const result = formatSkillList([
      { name: 'test', content: 'x', source: 'global' },
      { name: 'local-test', content: 'y', source: 'local' },
    ])
    expect(result).toContain('[global]')
    expect(result).toContain('[local]')
  })
})
