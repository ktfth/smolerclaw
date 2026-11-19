import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gatherContext } from './context'

export interface Skill {
  name: string
  content: string
  source: 'global' | 'local'
}

/**
 * Load skills from a directory. Returns skills with source tag.
 */
function loadFromDir(dir: string, source: 'global' | 'local'): Skill[] {
  if (!existsSync(dir)) return []

  const skills: Skill[] = []
  const entries = readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = readFileSync(join(dir, entry.name), 'utf-8')
      skills.push({ name: entry.name.replace('.md', ''), content: content.trim(), source })
    } else if (entry.isDirectory()) {
      const skillFile = join(dir, entry.name, 'SKILL.md')
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, 'utf-8')
        skills.push({ name: entry.name, content: content.trim(), source })
      }
    }
  }

  return skills
}

/**
 * Load skills from global dir + project-local .smolerclaw/skills/.
 * Local skills override global skills with the same name.
 */
export function loadSkills(globalDir: string): Skill[] {
  const globalSkills = loadFromDir(globalDir, 'global')
  const localDir = join(process.cwd(), '.smolerclaw', 'skills')
  const localSkills = loadFromDir(localDir, 'local')

  // Merge: local overrides global by name
  const merged = new Map<string, Skill>()
  for (const s of globalSkills) merged.set(s.name, s)
  for (const s of localSkills) merged.set(s.name, s) // override

  return [...merged.values()]
}

/**
 * Format skill list for display with source labels.
 */
export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) return 'No skills loaded.'
  return 'Skills:\n' + skills
    .map((s) => `  ${s.name} [${s.source}]`)
    .join('\n')
}

export function buildSystemPrompt(
  basePrompt: string,
  skills: Skill[],
  language: string = 'auto',
): string {
  const parts: string[] = []

  for (const skill of skills) {
    parts.push(skill.content)
  }

  if (language && language !== 'auto') {
    const langNames: Record<string, string> = {
      pt: 'Portuguese (Brazilian)',
      en: 'English',
      es: 'Spanish',
      fr: 'French',
      de: 'German',
      it: 'Italian',
      ja: 'Japanese',
      ko: 'Korean',
      zh: 'Chinese',
    }
    const langName = langNames[language] || language
    parts.push(`## Language Override\nALWAYS respond in ${langName}. This is a hard requirement.`)
  }

  parts.push(
    '---\n' +
    '## Environment\n' +
    'The user\'s current working directory and project info. Use this context when they ask about code or files.\n\n' +
    gatherContext(),
  )

  if (basePrompt) {
    parts.push('## User Instructions\n' + basePrompt)
  }

  return parts.join('\n\n')
}
