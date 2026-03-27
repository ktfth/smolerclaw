/**
 * Project management — track active projects, work sessions,
 * generate progress reports, and manage opportunities.
 *
 * Integrates with:
 *   - git.ts for commit history analysis
 *   - tasks.ts for completed task counts
 *   - briefing/morning for daily summaries
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  path: string              // filesystem path to the project root
  description: string
  tags: string[]
  techStack: string[]       // e.g. ['typescript', 'bun', 'react']
  createdAt: string
  active: boolean
}

export interface WorkSession {
  id: string
  projectId: string
  startedAt: string
  endedAt: string | null
  durationMinutes: number
  notes: string
}

export interface Opportunity {
  id: string
  title: string
  description: string
  source: string            // where this opportunity came from
  techRequired: string[]
  priority: 'alta' | 'media' | 'baixa'
  status: 'nova' | 'em_analise' | 'aceita' | 'recusada' | 'concluida'
  deadline: string | null
  createdAt: string
  updatedAt: string
}

export interface GitSummary {
  commits: number
  authors: string[]
  filesChanged: number
  insertions: number
  deletions: number
  topFiles: string[]
  messages: string[]
}

export interface WorkReport {
  project: Project
  period: string
  gitSummary: GitSummary | null
  sessions: WorkSession[]
  totalMinutes: number
  completedTasks: number
  markdown: string
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _projects: Project[] = []
let _sessions: WorkSession[] = []
let _opportunities: Opportunity[] = []
let _activeProjectId: string | null = null

const PROJECTS_FILE = () => join(_dataDir, 'projects.json')
const SESSIONS_FILE = () => join(_dataDir, 'work-sessions.json')
const OPPORTUNITIES_FILE = () => join(_dataDir, 'opportunities.json')
const ACTIVE_FILE = () => join(_dataDir, 'active-project.txt')

function saveProjects(): void {
  atomicWriteFile(PROJECTS_FILE(), JSON.stringify(_projects, null, 2))
}

function saveSessions(): void {
  atomicWriteFile(SESSIONS_FILE(), JSON.stringify(_sessions, null, 2))
}

function saveOpportunities(): void {
  atomicWriteFile(OPPORTUNITIES_FILE(), JSON.stringify(_opportunities, null, 2))
}

function saveActive(): void {
  atomicWriteFile(ACTIVE_FILE(), _activeProjectId || '')
}

function loadAll(): void {
  _projects = loadJson(PROJECTS_FILE, [])
  _sessions = loadJson(SESSIONS_FILE, [])
  _opportunities = loadJson(OPPORTUNITIES_FILE, [])

  const activeFile = ACTIVE_FILE()
  if (existsSync(activeFile)) {
    try {
      const id = readFileSync(activeFile, 'utf-8').trim()
      _activeProjectId = id || null
    } catch {
      _activeProjectId = null
    }
  }
}

function loadJson<T>(fileFn: () => string, fallback: T): T {
  const file = fileFn()
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`[projects] Failed to load ${file}: ${err instanceof Error ? err.message : err}`)
    }
    return fallback
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initProjects(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  loadAll()
}

// ─── Project CRUD ───────────────────────────────────────────

export function addProject(
  name: string,
  path: string,
  description: string = '',
  tags: string[] = [],
  techStack: string[] = [],
): Project {
  const project: Project = {
    id: genId(),
    name: name.trim(),
    path: path.trim(),
    description: description.trim(),
    tags: tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
    techStack: techStack.map((t) => t.trim().toLowerCase()).filter(Boolean),
    createdAt: new Date().toISOString(),
    active: true,
  }
  _projects = [..._projects, project]
  saveProjects()
  return project
}

export function getProject(idOrName: string): Project | null {
  const lower = idOrName.toLowerCase().trim()
  return (
    _projects.find((p) => p.id === idOrName) ||
    _projects.find((p) => p.name.toLowerCase() === lower) ||
    _projects.find((p) => p.name.toLowerCase().includes(lower)) ||
    null
  )
}

export function listProjects(activeOnly: boolean = false): Project[] {
  const result = activeOnly ? _projects.filter((p) => p.active) : [..._projects]
  return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'tags' | 'techStack' | 'active'>>): Project | null {
  const found = _projects.find((p) => p.id === id)
  if (!found) return null

  _projects = _projects.map((p) =>
    p.id === id ? { ...p, ...updates } : p,
  )
  saveProjects()
  return _projects.find((p) => p.id === id) || null
}

export function removeProject(id: string): boolean {
  const idx = _projects.findIndex((p) => p.id === id)
  if (idx === -1) return false
  _projects = [..._projects.slice(0, idx), ..._projects.slice(idx + 1)]
  saveProjects()
  if (_activeProjectId === id) {
    _activeProjectId = null
    saveActive()
  }
  return true
}

// ─── Active Project ─────────────────────────────────────────

export function setActiveProject(idOrName: string): Project | null {
  const project = getProject(idOrName)
  if (!project) return null
  _activeProjectId = project.id
  saveActive()
  return project
}

export function getActiveProject(): Project | null {
  if (!_activeProjectId) return null
  return _projects.find((p) => p.id === _activeProjectId) || null
}

export function clearActiveProject(): void {
  _activeProjectId = null
  saveActive()
}

// ─── Work Sessions ──────────────────────────────────────────

export function startSession(projectId: string, notes: string = ''): WorkSession | null {
  const project = _projects.find((p) => p.id === projectId)
  if (!project) return null

  // Close any open session for this project
  endOpenSessions(projectId)

  const session: WorkSession = {
    id: genId(),
    projectId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMinutes: 0,
    notes: notes.trim(),
  }
  _sessions = [..._sessions, session]
  saveSessions()
  return session
}

export function endSession(sessionId: string, notes?: string): WorkSession | null {
  const found = _sessions.find((s) => s.id === sessionId)
  if (!found || found.endedAt) return null

  const now = new Date()
  const start = new Date(found.startedAt)
  const duration = Math.round((now.getTime() - start.getTime()) / 60_000)

  _sessions = _sessions.map((s) =>
    s.id === sessionId
      ? {
          ...s,
          endedAt: now.toISOString(),
          durationMinutes: duration,
          notes: notes ? `${s.notes}\n${notes}`.trim() : s.notes,
        }
      : s,
  )
  saveSessions()
  return _sessions.find((s) => s.id === sessionId) || null
}

function endOpenSessions(projectId: string): void {
  const now = new Date()
  _sessions = _sessions.map((s) => {
    if (s.projectId === projectId && !s.endedAt) {
      const start = new Date(s.startedAt)
      const duration = Math.round((now.getTime() - start.getTime()) / 60_000)
      return { ...s, endedAt: now.toISOString(), durationMinutes: duration }
    }
    return s
  })
  saveSessions()
}

export function getOpenSession(projectId?: string): WorkSession | null {
  return (
    _sessions.find(
      (s) => !s.endedAt && (projectId ? s.projectId === projectId : true),
    ) || null
  )
}

export function getSessionsForPeriod(
  projectId: string,
  since: Date,
  until?: Date,
): WorkSession[] {
  const end = until || new Date()
  return _sessions.filter((s) => {
    if (s.projectId !== projectId) return false
    const started = new Date(s.startedAt)
    return started >= since && started <= end
  })
}

// ─── Git Summary ────────────────────────────────────────────

/**
 * Analyze git history for a project directory.
 * Uses Bun.spawn to run git commands safely (no shell interpolation).
 */
export async function getGitSummary(
  projectPath: string,
  since: string = '1 day ago',
): Promise<GitSummary | null> {
  if (!existsSync(join(projectPath, '.git'))) return null

  try {
    // Get commit count, authors, and messages
    const logResult = await gitExec(
      ['git', 'log', `--since=${since}`, '--format=%an|||%s', '--no-merges'],
      projectPath,
    )

    if (!logResult.ok || !logResult.stdout.trim()) {
      return {
        commits: 0,
        authors: [],
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        topFiles: [],
        messages: [],
      }
    }

    const logLines = logResult.stdout.trim().split('\n').filter(Boolean)
    const authors = [...new Set(logLines.map((l) => l.split('|||')[0]))]
    const messages = logLines.map((l) => l.split('|||')[1] || '').filter(Boolean)

    // Get diffstat
    const statResult = await gitExec(
      ['git', 'diff', '--stat', `--since=${since}`, 'HEAD'],
      projectPath,
    )

    // Get shortstat for numbers
    const shortResult = await gitExec(
      ['git', 'log', `--since=${since}`, '--shortstat', '--format=', '--no-merges'],
      projectPath,
    )

    let filesChanged = 0
    let insertions = 0
    let deletions = 0

    if (shortResult.ok && shortResult.stdout.trim()) {
      for (const line of shortResult.stdout.trim().split('\n')) {
        const filesMatch = line.match(/(\d+)\s+files?\s+changed/)
        const insMatch = line.match(/(\d+)\s+insertions?/)
        const delMatch = line.match(/(\d+)\s+deletions?/)
        if (filesMatch) filesChanged += parseInt(filesMatch[1])
        if (insMatch) insertions += parseInt(insMatch[1])
        if (delMatch) deletions += parseInt(delMatch[1])
      }
    }

    // Get top changed files
    const nameResult = await gitExec(
      ['git', 'log', `--since=${since}`, '--name-only', '--format=', '--no-merges'],
      projectPath,
    )

    const fileCounts = new Map<string, number>()
    if (nameResult.ok && nameResult.stdout.trim()) {
      for (const file of nameResult.stdout.trim().split('\n').filter(Boolean)) {
        fileCounts.set(file, (fileCounts.get(file) || 0) + 1)
      }
    }
    const topFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file]) => file)

    return {
      commits: logLines.length,
      authors,
      filesChanged,
      insertions,
      deletions,
      topFiles,
      messages,
    }
  } catch {
    return null
  }
}

async function gitExec(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', cwd })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { stdout: stdout.trim(), stderr: stderr.trim(), ok: code === 0 }
}

// ─── Opportunities ──────────────────────────────────────────

export function addOpportunity(
  title: string,
  description: string,
  source: string,
  techRequired: string[] = [],
  priority: Opportunity['priority'] = 'media',
  deadline: string | null = null,
): Opportunity {
  const now = new Date().toISOString()
  const opp: Opportunity = {
    id: genId(),
    title: title.trim(),
    description: description.trim(),
    source: source.trim(),
    techRequired: techRequired.map((t) => t.toLowerCase()),
    priority,
    status: 'nova',
    deadline,
    createdAt: now,
    updatedAt: now,
  }
  _opportunities = [..._opportunities, opp]
  saveOpportunities()
  return opp
}

export function updateOpportunityStatus(
  id: string,
  status: Opportunity['status'],
): Opportunity | null {
  const found = _opportunities.find((o) => o.id === id)
  if (!found) return null

  _opportunities = _opportunities.map((o) =>
    o.id === id ? { ...o, status, updatedAt: new Date().toISOString() } : o,
  )
  saveOpportunities()
  return _opportunities.find((o) => o.id === id) || null
}

export function listOpportunities(
  status?: Opportunity['status'],
  techFilter?: string[],
): Opportunity[] {
  let result = [..._opportunities]

  if (status) {
    result = result.filter((o) => o.status === status)
  }

  if (techFilter && techFilter.length > 0) {
    const filterLower = techFilter.map((t) => t.toLowerCase())
    result = result.filter((o) =>
      o.techRequired.some((t) => filterLower.includes(t)),
    )
  }

  return result.sort((a, b) => {
    const prio = { alta: 3, media: 2, baixa: 1 }
    return (prio[b.priority] || 0) - (prio[a.priority] || 0)
  })
}

export function removeOpportunity(id: string): boolean {
  const idx = _opportunities.findIndex((o) => o.id === id)
  if (idx === -1) return false
  _opportunities = [..._opportunities.slice(0, idx), ..._opportunities.slice(idx + 1)]
  saveOpportunities()
  return true
}

// ─── Report Generation ──────────────────────────────────────

/**
 * Generate a work progress report for a project.
 * @param projectId Project ID or name
 * @param period 'today' | 'week' | 'month'
 * @param lang 'pt' | 'en'
 */
export async function generateWorkReport(
  projectId: string,
  period: 'today' | 'week' | 'month' = 'today',
  lang: 'pt' | 'en' = 'pt',
): Promise<WorkReport | null> {
  const project = getProject(projectId)
  if (!project) return null

  const now = new Date()
  const since = new Date(now)

  switch (period) {
    case 'today':
      since.setHours(0, 0, 0, 0)
      break
    case 'week':
      since.setDate(since.getDate() - 7)
      break
    case 'month':
      since.setDate(since.getDate() - 30)
      break
  }

  const gitSince = period === 'today' ? '1 day ago' : period === 'week' ? '7 days ago' : '30 days ago'
  const gitSummary = await getGitSummary(project.path, gitSince)
  const sessions = getSessionsForPeriod(project.id, since)
  const totalMinutes = sessions.reduce((sum, s) => sum + s.durationMinutes, 0)

  // Count tasks completed in period (from tasks.json — loose coupling)
  let completedTasks = 0
  try {
    const tasksFile = join(_dataDir, 'tasks.json')
    if (existsSync(tasksFile)) {
      const tasks: Array<{ done: boolean; createdAt: string }> = JSON.parse(
        readFileSync(tasksFile, 'utf-8'),
      )
      completedTasks = tasks.filter((t) => {
        if (!t.done) return false
        const created = new Date(t.createdAt)
        return created >= since
      }).length
    }
  } catch { /* skip */ }

  const markdown = formatReport(project, period, gitSummary, sessions, totalMinutes, completedTasks, lang)

  return {
    project,
    period,
    gitSummary,
    sessions,
    totalMinutes,
    completedTasks,
    markdown,
  }
}

function formatReport(
  project: Project,
  period: string,
  git: GitSummary | null,
  sessions: WorkSession[],
  totalMinutes: number,
  completedTasks: number,
  lang: 'pt' | 'en',
): string {
  const isPt = lang === 'pt'
  const lines: string[] = []
  const now = new Date()
  const dateStr = now.toLocaleDateString(isPt ? 'pt-BR' : 'en-US', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })

  // Header
  lines.push(`# ${isPt ? 'Relatorio de Progresso' : 'Work Progress Report'}`)
  lines.push(`**${isPt ? 'Projeto' : 'Project'}:** ${project.name}`)
  lines.push(`**${isPt ? 'Periodo' : 'Period'}:** ${period} (${dateStr})`)
  lines.push(`**${isPt ? 'Caminho' : 'Path'}:** \`${project.path}\``)
  if (project.techStack.length > 0) {
    lines.push(`**Tech:** ${project.techStack.join(', ')}`)
  }
  lines.push('')

  // Time summary
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  lines.push(`## ${isPt ? 'Tempo Trabalhado' : 'Time Tracked'}`)
  lines.push(`- **${isPt ? 'Total' : 'Total'}:** ${hours}h ${mins}m`)
  lines.push(`- **${isPt ? 'Sessoes' : 'Sessions'}:** ${sessions.length}`)
  if (completedTasks > 0) {
    lines.push(`- **${isPt ? 'Tarefas concluidas' : 'Tasks completed'}:** ${completedTasks}`)
  }
  lines.push('')

  // Git summary
  if (git && git.commits > 0) {
    lines.push(`## ${isPt ? 'Atividade Git' : 'Git Activity'}`)
    lines.push(`- **Commits:** ${git.commits}`)
    if (git.authors.length > 0) {
      lines.push(`- **${isPt ? 'Autores' : 'Authors'}:** ${git.authors.join(', ')}`)
    }
    lines.push(`- **${isPt ? 'Arquivos alterados' : 'Files changed'}:** ${git.filesChanged}`)
    lines.push(`- **${isPt ? 'Linhas' : 'Lines'}:** +${git.insertions} / -${git.deletions}`)

    if (git.messages.length > 0) {
      lines.push('')
      lines.push(`### ${isPt ? 'Commits recentes' : 'Recent commits'}`)
      for (const msg of git.messages.slice(0, 15)) {
        lines.push(`- ${msg}`)
      }
    }

    if (git.topFiles.length > 0) {
      lines.push('')
      lines.push(`### ${isPt ? 'Arquivos mais alterados' : 'Most changed files'}`)
      for (const file of git.topFiles.slice(0, 8)) {
        lines.push(`- \`${file}\``)
      }
    }
    lines.push('')
  } else {
    lines.push(`## ${isPt ? 'Atividade Git' : 'Git Activity'}`)
    lines.push(isPt ? '_Nenhum commit no periodo._' : '_No commits in this period._')
    lines.push('')
  }

  // Sessions detail
  if (sessions.length > 0) {
    lines.push(`## ${isPt ? 'Sessoes de Trabalho' : 'Work Sessions'}`)
    for (const s of sessions) {
      const start = new Date(s.startedAt).toLocaleTimeString(isPt ? 'pt-BR' : 'en-US', {
        hour: '2-digit', minute: '2-digit',
      })
      const durStr = s.durationMinutes > 0 ? `${s.durationMinutes}m` : isPt ? 'em andamento' : 'ongoing'
      const note = s.notes ? ` — ${s.notes}` : ''
      lines.push(`- ${start} (${durStr})${note}`)
    }
    lines.push('')
  }

  // Footer
  lines.push('---')
  lines.push(isPt
    ? `_Gerado por smolerclaw em ${now.toLocaleString('pt-BR')}_`
    : `_Generated by smolerclaw at ${now.toLocaleString('en-US')}_`,
  )

  return lines.join('\n')
}

// ─── Formatting ─────────────────────────────────────────────

export function formatProjectList(projects: Project[]): string {
  if (projects.length === 0) return 'Nenhum projeto cadastrado.'

  const lines = projects.map((p) => {
    const active = p.id === _activeProjectId ? ' [ATIVO]' : ''
    const status = p.active ? '' : ' (inativo)'
    const tech = p.techStack.length > 0 ? ` [${p.techStack.join(', ')}]` : ''
    return `  ${p.name}${active}${status}${tech} — ${p.path}  {${p.id}}`
  })

  return `Projetos (${projects.length}):\n${lines.join('\n')}`
}

export function formatProjectDetail(project: Project): string {
  const active = project.id === _activeProjectId ? ' [ATIVO]' : ''
  const lines: string[] = [
    `--- Projeto {${project.id}}${active} ---`,
    `Nome: ${project.name}`,
    `Caminho: ${project.path}`,
  ]
  if (project.description) lines.push(`Descricao: ${project.description}`)
  if (project.techStack.length > 0) lines.push(`Tech: ${project.techStack.join(', ')}`)
  if (project.tags.length > 0) lines.push(`Tags: ${project.tags.map((t) => `#${t}`).join(' ')}`)
  lines.push(`Criado: ${new Date(project.createdAt).toLocaleDateString('pt-BR')}`)
  lines.push(`Status: ${project.active ? 'ativo' : 'inativo'}`)

  // Open session
  const open = getOpenSession(project.id)
  if (open) {
    const started = new Date(open.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    lines.push(`Sessao aberta: desde ${started}`)
  }

  return lines.join('\n')
}

export function formatOpportunityList(opps: Opportunity[]): string {
  if (opps.length === 0) return 'Nenhuma oportunidade encontrada.'

  const lines = opps.map((o) => {
    const prio = { alta: '!!!', media: '!!', baixa: '!' }[o.priority]
    const tech = o.techRequired.length > 0 ? ` [${o.techRequired.join(', ')}]` : ''
    const deadline = o.deadline ? ` — prazo: ${o.deadline}` : ''
    return `  ${prio} (${o.status}) ${o.title}${tech}${deadline} — ${o.source}  {${o.id}}`
  })

  return `Oportunidades (${opps.length}):\n${lines.join('\n')}`
}

/**
 * Generate a summary for the morning briefing.
 */
export function getProjectBriefingSummary(): string {
  const active = getActiveProject()
  if (!active) return ''

  const open = getOpenSession(active.id)
  const newOpps = _opportunities.filter((o) => o.status === 'nova').length

  const lines: string[] = ['--- Projetos ---']
  lines.push(`Projeto ativo: ${active.name} (${active.path})`)
  if (open) {
    const started = new Date(open.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    lines.push(`Sessao aberta desde ${started}`)
  }
  if (newOpps > 0) {
    lines.push(`${newOpps} oportunidade(s) nova(s) pendente(s)`)
  }
  return lines.join('\n')
}

// ─── Auto-detect project from CWD ──────────────────────────

/**
 * Try to auto-register the current directory as a project.
 * Only if it's a git repo and not already registered.
 */
export function autoDetectProject(cwd: string): Project | null {
  // Check if already registered
  const existing = _projects.find((p) => p.path === cwd)
  if (existing) return existing

  // Check if it's a git repo
  if (!existsSync(join(cwd, '.git'))) return null

  // Auto-detect tech stack from common files
  const techStack: string[] = []
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
      if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) techStack.push('typescript')
      if (pkg.dependencies?.react) techStack.push('react')
      if (pkg.dependencies?.next) techStack.push('nextjs')
      if (pkg.dependencies?.vue) techStack.push('vue')
      if (existsSync(join(cwd, 'bun.lock'))) techStack.push('bun')
      else techStack.push('node')
    } catch { /* skip */ }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) techStack.push('rust')
  if (existsSync(join(cwd, 'go.mod'))) techStack.push('go')
  if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) techStack.push('python')

  const name = basename(cwd)
  return addProject(name, cwd, '', [], techStack)
}

// ─── Helpers ────────────────────────────────────────────────

function genId(): string {
  return randomUUID().slice(0, 8)
}
