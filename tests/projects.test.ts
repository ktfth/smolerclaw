import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initProjects, addProject, getProject, listProjects, updateProject, removeProject,
  setActiveProject, getActiveProject, clearActiveProject,
  startSession, endSession, getOpenSession, getSessionsForPeriod,
  addOpportunity, updateOpportunityStatus, listOpportunities, removeOpportunity,
  generateWorkReport, autoDetectProject, getProjectBriefingSummary,
  formatProjectList, formatProjectDetail, formatOpportunityList,
} from '../src/projects'

const TEST_DIR = join(tmpdir(), `smolerclaw-projects-test-${Date.now()}`)

function cleanup(): void {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('Project Management', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(TEST_DIR, { recursive: true })
    initProjects(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  // ─── Project CRUD ───────────────────────────────────────

  test('addProject creates a project', () => {
    const p = addProject('tinyclaw', '/home/user/tinyclaw', 'micro AI assistant', ['ai'], ['typescript', 'bun'])
    expect(p.name).toBe('tinyclaw')
    expect(p.path).toBe('/home/user/tinyclaw')
    expect(p.techStack).toEqual(['typescript', 'bun'])
    expect(p.active).toBe(true)
    expect(p.id).toBeTruthy()
  })

  test('getProject by name', () => {
    addProject('myapp', '/path/to/myapp')
    const found = getProject('myapp')
    expect(found).toBeTruthy()
    expect(found!.name).toBe('myapp')
  })

  test('getProject by partial name', () => {
    addProject('frontend-dashboard', '/path/to/dash')
    const found = getProject('frontend')
    expect(found).toBeTruthy()
    expect(found!.name).toBe('frontend-dashboard')
  })

  test('getProject by id', () => {
    const p = addProject('api-server', '/path/to/api')
    const found = getProject(p.id)
    expect(found).toBeTruthy()
    expect(found!.id).toBe(p.id)
  })

  test('listProjects returns all', () => {
    addProject('a', '/a')
    addProject('b', '/b')
    addProject('c', '/c')
    expect(listProjects().length).toBe(3)
  })

  test('listProjects activeOnly', () => {
    const p = addProject('old', '/old')
    addProject('new', '/new')
    updateProject(p.id, { active: false })
    expect(listProjects(true).length).toBe(1)
    expect(listProjects(false).length).toBe(2)
  })

  test('updateProject', () => {
    const p = addProject('app', '/app')
    const updated = updateProject(p.id, { description: 'Updated desc', techStack: ['rust'] })
    expect(updated).toBeTruthy()
    expect(updated!.description).toBe('Updated desc')
    expect(updated!.techStack).toEqual(['rust'])
  })

  test('removeProject', () => {
    const p = addProject('temp', '/temp')
    expect(removeProject(p.id)).toBe(true)
    expect(listProjects().length).toBe(0)
  })

  test('removeProject clears active if needed', () => {
    const p = addProject('active-one', '/active')
    setActiveProject(p.id)
    expect(getActiveProject()).toBeTruthy()
    removeProject(p.id)
    expect(getActiveProject()).toBeNull()
  })

  // ─── Active Project ─────────────────────────────────────

  test('setActiveProject and getActiveProject', () => {
    const p = addProject('main', '/main')
    setActiveProject(p.id)
    const active = getActiveProject()
    expect(active).toBeTruthy()
    expect(active!.id).toBe(p.id)
  })

  test('clearActiveProject', () => {
    const p = addProject('main', '/main')
    setActiveProject(p.id)
    clearActiveProject()
    expect(getActiveProject()).toBeNull()
  })

  test('setActiveProject by name', () => {
    addProject('backend', '/backend')
    const result = setActiveProject('backend')
    expect(result).toBeTruthy()
    expect(result!.name).toBe('backend')
  })

  // ─── Work Sessions ─────────────────────────────────────

  test('startSession creates open session', () => {
    const p = addProject('proj', '/proj')
    const s = startSession(p.id, 'Working on feature X')
    expect(s).toBeTruthy()
    expect(s!.projectId).toBe(p.id)
    expect(s!.endedAt).toBeNull()
    expect(s!.notes).toBe('Working on feature X')
  })

  test('endSession calculates duration', async () => {
    const p = addProject('proj', '/proj')
    const s = startSession(p.id)
    expect(s).toBeTruthy()

    // Small delay to have non-zero duration
    await new Promise((r) => setTimeout(r, 50))

    const ended = endSession(s!.id)
    expect(ended).toBeTruthy()
    expect(ended!.endedAt).toBeTruthy()
    expect(ended!.durationMinutes).toBeGreaterThanOrEqual(0)
  })

  test('startSession closes previous open session', () => {
    const p = addProject('proj', '/proj')
    startSession(p.id, 'First')
    const s2 = startSession(p.id, 'Second')
    expect(s2).toBeTruthy()
    // First session should be closed
    const open = getOpenSession(p.id)
    expect(open).toBeTruthy()
    expect(open!.notes).toBe('Second')
  })

  test('getOpenSession returns null when none open', () => {
    const p = addProject('proj', '/proj')
    expect(getOpenSession(p.id)).toBeNull()
  })

  test('getSessionsForPeriod filters by date', () => {
    const p = addProject('proj', '/proj')
    const s = startSession(p.id)
    if (s) endSession(s.id)

    const since = new Date()
    since.setHours(0, 0, 0, 0)
    const sessions = getSessionsForPeriod(p.id, since)
    expect(sessions.length).toBe(1)

    // Yesterday should return nothing
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(23, 59, 59, 999)
    const oldSessions = getSessionsForPeriod(p.id, new Date(0), yesterday)
    expect(oldSessions.length).toBe(0)
  })

  // ─── Opportunities ─────────────────────────────────────

  test('addOpportunity creates opportunity', () => {
    const o = addOpportunity('Build dashboard', 'React admin panel', 'LinkedIn', ['react', 'typescript'], 'alta')
    expect(o.title).toBe('Build dashboard')
    expect(o.status).toBe('nova')
    expect(o.priority).toBe('alta')
    expect(o.techRequired).toEqual(['react', 'typescript'])
  })

  test('listOpportunities sorts by priority', () => {
    addOpportunity('Low', 'desc', 'src', [], 'baixa')
    addOpportunity('High', 'desc', 'src', [], 'alta')
    addOpportunity('Med', 'desc', 'src', [], 'media')

    const opps = listOpportunities()
    expect(opps[0].title).toBe('High')
    expect(opps[1].title).toBe('Med')
    expect(opps[2].title).toBe('Low')
  })

  test('listOpportunities filters by status', () => {
    addOpportunity('A', 'desc', 'src')
    const o = addOpportunity('B', 'desc', 'src')
    updateOpportunityStatus(o.id, 'aceita')

    expect(listOpportunities('nova').length).toBe(1)
    expect(listOpportunities('aceita').length).toBe(1)
  })

  test('listOpportunities filters by tech', () => {
    addOpportunity('React job', 'desc', 'src', ['react'])
    addOpportunity('Go job', 'desc', 'src', ['go'])

    expect(listOpportunities(undefined, ['react']).length).toBe(1)
    expect(listOpportunities(undefined, ['go']).length).toBe(1)
    expect(listOpportunities(undefined, ['python']).length).toBe(0)
  })

  test('updateOpportunityStatus', () => {
    const o = addOpportunity('Test', 'desc', 'src')
    const updated = updateOpportunityStatus(o.id, 'em_analise')
    expect(updated).toBeTruthy()
    expect(updated!.status).toBe('em_analise')
  })

  test('removeOpportunity', () => {
    const o = addOpportunity('Temp', 'desc', 'src')
    expect(removeOpportunity(o.id)).toBe(true)
    expect(listOpportunities().length).toBe(0)
  })

  // ─── Report Generation ─────────────────────────────────

  test('generateWorkReport returns null for unknown project', async () => {
    const report = await generateWorkReport('nonexistent')
    expect(report).toBeNull()
  })

  test('generateWorkReport generates markdown for valid project', async () => {
    const p = addProject('test-proj', TEST_DIR)
    const s = startSession(p.id, 'Testing')
    if (s) endSession(s.id)

    const report = await generateWorkReport(p.id, 'today', 'pt')
    expect(report).toBeTruthy()
    expect(report!.markdown).toContain('Relatorio de Progresso')
    expect(report!.markdown).toContain('test-proj')
    expect(report!.project.id).toBe(p.id)
  })

  test('generateWorkReport supports English', async () => {
    const p = addProject('eng-proj', TEST_DIR)
    const report = await generateWorkReport(p.id, 'today', 'en')
    expect(report).toBeTruthy()
    expect(report!.markdown).toContain('Work Progress Report')
  })

  test('generateWorkReport includes sessions', async () => {
    const p = addProject('with-sessions', TEST_DIR)
    const s = startSession(p.id, 'Session note')
    if (s) endSession(s.id)

    const report = await generateWorkReport(p.id, 'today', 'pt')
    expect(report!.sessions.length).toBe(1)
    expect(report!.markdown).toContain('Sessoes de Trabalho')
  })

  // ─── Auto-detect ────────────────────────────────────────

  test('autoDetectProject returns null for non-git dir', () => {
    const nonGitDir = join(TEST_DIR, 'no-git')
    mkdirSync(nonGitDir, { recursive: true })
    expect(autoDetectProject(nonGitDir)).toBeNull()
  })

  test('autoDetectProject detects git repo', () => {
    const gitDir = join(TEST_DIR, 'my-repo')
    mkdirSync(join(gitDir, '.git'), { recursive: true })
    const detected = autoDetectProject(gitDir)
    expect(detected).toBeTruthy()
    expect(detected!.name).toBe('my-repo')
    expect(detected!.path).toBe(gitDir)
  })

  test('autoDetectProject detects tech stack from package.json', () => {
    const dir = join(TEST_DIR, 'ts-project')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5.0.0' },
    }))
    const detected = autoDetectProject(dir)
    expect(detected).toBeTruthy()
    expect(detected!.techStack).toContain('typescript')
  })

  test('autoDetectProject returns existing if already registered', () => {
    const dir = join(TEST_DIR, 'existing')
    mkdirSync(join(dir, '.git'), { recursive: true })
    const first = autoDetectProject(dir)
    const second = autoDetectProject(dir)
    expect(first!.id).toBe(second!.id) // Same project, not duplicated
  })

  // ─── Briefing Summary ──────────────────────────────────

  test('getProjectBriefingSummary returns empty when no active project', () => {
    expect(getProjectBriefingSummary()).toBe('')
  })

  test('getProjectBriefingSummary returns info when active', () => {
    const p = addProject('active', '/active')
    setActiveProject(p.id)
    const summary = getProjectBriefingSummary()
    expect(summary).toContain('Projeto ativo: active')
  })

  // ─── Formatting ────────────────────────────────────────

  test('formatProjectList handles empty', () => {
    expect(formatProjectList([])).toContain('Nenhum projeto')
  })

  test('formatProjectList shows projects', () => {
    const p = addProject('app', '/app', '', [], ['ts'])
    const text = formatProjectList([p])
    expect(text).toContain('app')
    expect(text).toContain('ts')
  })

  test('formatProjectDetail shows detail', () => {
    const p = addProject('detail-test', '/detail', 'A test project', ['test'], ['go'])
    const text = formatProjectDetail(p)
    expect(text).toContain('detail-test')
    expect(text).toContain('/detail')
    expect(text).toContain('go')
  })

  test('formatOpportunityList handles empty', () => {
    expect(formatOpportunityList([])).toContain('Nenhuma oportunidade')
  })

  // ─── Persistence ────────────────────────────────────────

  test('data persists across re-init', () => {
    addProject('persist', '/persist')
    addOpportunity('Opp', 'desc', 'src')

    // Re-init
    initProjects(TEST_DIR)
    expect(listProjects().length).toBe(1)
    expect(listOpportunities().length).toBe(1)
  })

  // ─── Edge Cases ────────────────────────────────────────

  test('getProject returns null for nonexistent', () => {
    expect(getProject('nonexistent')).toBeNull()
  })

  test('updateProject returns null for nonexistent', () => {
    expect(updateProject('badid', { name: 'new' })).toBeNull()
  })

  test('removeProject returns false for nonexistent', () => {
    expect(removeProject('badid')).toBe(false)
  })

  test('setActiveProject returns null for nonexistent', () => {
    expect(setActiveProject('badid')).toBeNull()
  })

  test('startSession returns null for nonexistent project', () => {
    expect(startSession('badid')).toBeNull()
  })

  test('endSession returns null for nonexistent session', () => {
    expect(endSession('badid')).toBeNull()
  })

  test('endSession returns null for already ended session', () => {
    const p = addProject('proj', '/proj')
    const s = startSession(p.id)
    if (s) endSession(s.id)
    // Try to end again
    if (s) expect(endSession(s.id)).toBeNull()
  })

  test('updateOpportunityStatus returns null for nonexistent', () => {
    expect(updateOpportunityStatus('badid', 'aceita')).toBeNull()
  })

  test('removeOpportunity returns false for nonexistent', () => {
    expect(removeOpportunity('badid')).toBe(false)
  })

  test('addProject trims and lowercases tags/tech', () => {
    const p = addProject('test', '/test', '', ['  AI  ', 'ML'], ['TypeScript', '  BUN  '])
    expect(p.tags).toEqual(['ai', 'ml'])
    expect(p.techStack).toEqual(['typescript', 'bun'])
  })

  test('addOpportunity lowercases tech_required', () => {
    const o = addOpportunity('Job', 'desc', 'src', ['React', 'TypeScript'])
    expect(o.techRequired).toEqual(['react', 'typescript'])
  })

  test('getActiveProject returns null when no active set', () => {
    expect(getActiveProject()).toBeNull()
  })

  test('clearActiveProject works after setting', () => {
    const p = addProject('x', '/x')
    setActiveProject(p.id)
    clearActiveProject()
    expect(getActiveProject()).toBeNull()
  })

  test('getOpenSession with no projectId returns any open session', () => {
    const p = addProject('any', '/any')
    startSession(p.id)
    const open = getOpenSession()
    expect(open).toBeTruthy()
    expect(open!.projectId).toBe(p.id)
  })

  test('generateWorkReport week period', async () => {
    const p = addProject('week-proj', TEST_DIR)
    const report = await generateWorkReport(p.id, 'week', 'pt')
    expect(report).toBeTruthy()
    expect(report!.period).toBe('week')
  })

  test('generateWorkReport month period', async () => {
    const p = addProject('month-proj', TEST_DIR)
    const report = await generateWorkReport(p.id, 'month', 'en')
    expect(report).toBeTruthy()
    expect(report!.markdown).toContain('Work Progress Report')
  })

  test('autoDetectProject detects Rust project', () => {
    const dir = join(TEST_DIR, 'rust-proj')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "myapp"')
    const detected = autoDetectProject(dir)
    expect(detected!.techStack).toContain('rust')
  })

  test('autoDetectProject detects Go project', () => {
    const dir = join(TEST_DIR, 'go-proj')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp')
    const detected = autoDetectProject(dir)
    expect(detected!.techStack).toContain('go')
  })

  test('autoDetectProject detects Python project', () => {
    const dir = join(TEST_DIR, 'py-proj')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'requirements.txt'), 'flask==3.0.0')
    const detected = autoDetectProject(dir)
    expect(detected!.techStack).toContain('python')
  })

  test('formatProjectList shows ATIVO marker for active project', () => {
    const p = addProject('marked', '/marked')
    setActiveProject(p.id)
    const text = formatProjectList(listProjects())
    expect(text).toContain('[ATIVO]')
  })

  test('formatProjectDetail shows open session info', () => {
    const p = addProject('with-session', '/with-session')
    startSession(p.id, 'coding')
    const text = formatProjectDetail(p)
    expect(text).toContain('Sessao aberta')
  })

  test('getProjectBriefingSummary shows new opportunities count', () => {
    const p = addProject('briefing-test', '/briefing')
    setActiveProject(p.id)
    addOpportunity('New opp', 'desc', 'src')
    const summary = getProjectBriefingSummary()
    expect(summary).toContain('1 oportunidade')
  })
})
