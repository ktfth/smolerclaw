import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initAgencyEngine,
  isAgencyEngineInitialized,
  analyzeTaskImpact,
  createPlan,
  addPlanStep,
  submitPlanForApproval,
  approvePlan,
  rejectPlan,
  canExecute,
  startExecution,
  completeStep,
  reportBlockedStep,
  abandonPlan,
  getCurrentPlan,
  getPlanHistory,
  formatPlanAsDraft,
  formatPlanStatus,
  getAgencyConfig,
  updateAgencyConfig,
  getAgencySystemPromptSection,
} from '../src/services/agency-engine'
import { resetEventBus, getEventBus } from '../src/core/event-bus'

describe('agency-engine', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agency-test-'))
    resetEventBus()
    initAgencyEngine(tempDir)
  })

  afterEach(() => {
    resetEventBus()
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('initialization', () => {
    it('initializes the agency engine', () => {
      expect(isAgencyEngineInitialized()).toBe(true)
    })

    it('creates data directory', () => {
      expect(existsSync(join(tempDir, 'agency-engine'))).toBe(true)
    })

    it('returns default config', () => {
      const config = getAgencyConfig()
      expect(config.requireApprovalFor).toContain('complex')
      expect(config.requireApprovalFor).toContain('architectural')
      expect(config.autoApproveComplexity).toContain('trivial')
      expect(config.autoApproveComplexity).toContain('simple')
    })

    it('updates config', () => {
      updateAgencyConfig({ maxStepsWithoutCheckpoint: 10 })
      const config = getAgencyConfig()
      expect(config.maxStepsWithoutCheckpoint).toBe(10)
    })
  })

  describe('analyzeTaskImpact', () => {
    it('classifies trivial tasks', () => {
      const result = analyzeTaskImpact('fix typo in README')
      expect(result.complexity).toBe('trivial')
      expect(result.requiresApproval).toBe(false)
    })

    it('classifies simple tasks', () => {
      const result = analyzeTaskImpact('rename variable from foo to bar')
      expect(result.complexity).toBe('simple')
      expect(result.requiresApproval).toBe(false)
    })

    it('classifies moderate tasks', () => {
      const result = analyzeTaskImpact('fix bug in user validation')
      expect(result.complexity).toBe('moderate')
      expect(result.requiresApproval).toBe(true)
    })

    it('classifies complex tasks', () => {
      const result = analyzeTaskImpact('implement feature for user authentication')
      expect(result.complexity).toBe('complex')
      expect(result.requiresApproval).toBe(true)
    })

    it('classifies architectural tasks', () => {
      const result = analyzeTaskImpact('refactor the entire module architecture')
      expect(result.complexity).toBe('architectural')
      expect(result.requiresApproval).toBe(true)
    })

    it('detects high-risk file patterns', () => {
      const result = analyzeTaskImpact('update settings', {
        files: ['config.ts', 'package.json', '.env'],
      })
      expect(result.risks.length).toBeGreaterThan(0)
      expect(result.risks.some(r => r.includes('sensitive file'))).toBe(true)
    })

    it('detects multi-file changes', () => {
      const result = analyzeTaskImpact('update imports', {
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      })
      expect(result.risks.some(r => r.includes('4 files'))).toBe(true)
    })

    it('detects cross-module changes', () => {
      const result = analyzeTaskImpact('refactor shared logic', {
        modules: ['auth', 'users', 'api'],
      })
      expect(result.risks.some(r => r.includes('3 modules'))).toBe(true)
    })

    it('adds assumptions for API tasks', () => {
      const result = analyzeTaskImpact('update the API endpoint')
      expect(result.assumptions.some(a => a.includes('API'))).toBe(true)
    })

    it('adds assumptions for database tasks', () => {
      const result = analyzeTaskImpact('modify database schema')
      expect(result.assumptions.some(a => a.includes('migration'))).toBe(true)
    })

    it('adds assumptions for security tasks', () => {
      const result = analyzeTaskImpact('implement authentication')
      expect(result.assumptions.some(a => a.includes('security') || a.includes('Security'))).toBe(true)
    })
  })

  describe('createPlan', () => {
    it('creates a plan with draft status', () => {
      const plan = createPlan('Test objective', [
        { action: 'Step 1', target: 'file.ts', description: 'Do something', estimatedImpact: 'low', dependencies: [] },
      ])

      expect(plan.status).toBe('draft')
      expect(plan.objective).toBe('Test objective')
      expect(plan.strategy.length).toBe(1)
      expect(plan.strategy[0].order).toBe(1)
      expect(plan.strategy[0].status).toBe('pending')
    })

    it('assigns unique IDs to plan and steps', () => {
      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'a.ts', description: 'A', estimatedImpact: 'low', dependencies: [] },
        { action: 'Step 2', target: 'b.ts', description: 'B', estimatedImpact: 'low', dependencies: [] },
      ])

      expect(plan.id).toBeDefined()
      expect(plan.strategy[0].id).toBeDefined()
      expect(plan.strategy[1].id).toBeDefined()
      expect(plan.strategy[0].id).not.toBe(plan.strategy[1].id)
    })

    it('includes provided assumptions and risks', () => {
      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ], {
        assumptions: ['Assumption 1'],
        risks: ['Risk 1'],
      })

      expect(plan.assumptions).toContain('Assumption 1')
      expect(plan.risks).toContain('Risk 1')
    })

    it('emits planning:started event', () => {
      let eventReceived = false
      const bus = getEventBus()
      bus.on('planning:started', () => {
        eventReceived = true
      })

      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      expect(eventReceived).toBe(true)
    })

    it('sets current plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      const current = getCurrentPlan()
      expect(current).not.toBeNull()
      expect(current?.objective).toBe('Test')
    })
  })

  describe('addPlanStep', () => {
    it('adds step to current plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'a.ts', description: 'A', estimatedImpact: 'low', dependencies: [] },
      ])

      const newStep = addPlanStep({
        action: 'Step 2',
        target: 'b.ts',
        description: 'B',
        estimatedImpact: 'medium',
        dependencies: [],
      })

      expect(newStep).not.toBeNull()
      expect(newStep?.order).toBe(2)

      const plan = getCurrentPlan()
      expect(plan?.strategy.length).toBe(2)
    })

    it('returns null if no current plan', () => {
      const result = addPlanStep({
        action: 'Step',
        target: 'file.ts',
        description: 'D',
        estimatedImpact: 'low',
        dependencies: [],
      })

      expect(result).toBeNull()
    })

    it('emits planning:step_added event', () => {
      let eventData: unknown = null
      const bus = getEventBus()
      bus.on('planning:step_added', (evt) => {
        eventData = evt
      })

      createPlan('Test', [
        { action: 'Step 1', target: 'a.ts', description: 'A', estimatedImpact: 'low', dependencies: [] },
      ])

      addPlanStep({
        action: 'Step 2',
        target: 'b.ts',
        description: 'B',
        estimatedImpact: 'low',
        dependencies: [],
      })

      expect(eventData).toBeDefined()
    })
  })

  describe('submitPlanForApproval', () => {
    it('changes status to pending_approval', async () => {
      createPlan('Complex task', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      await submitPlanForApproval()

      const plan = getCurrentPlan()
      expect(plan?.status).toBe('pending_approval')
    })

    it('auto-approves trivial/simple tasks', async () => {
      // Force trivial classification by changing config
      updateAgencyConfig({ autoApproveComplexity: ['trivial', 'simple', 'moderate', 'complex', 'architectural'] })

      createPlan('Fix typo', [
        { action: 'Fix', target: 'file.ts', description: 'Fix typo', estimatedImpact: 'none', dependencies: [] },
      ])

      const result = await submitPlanForApproval()

      expect(result.success).toBe(true)
      expect(result.plan?.status).toBe('approved')
    })

    it('returns error if no plan', async () => {
      const result = await submitPlanForApproval()
      expect(result.success).toBe(false)
      expect(result.message).toContain('No active plan')
    })
  })

  describe('approvePlan / rejectPlan', () => {
    it('approves plan and allows execution', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      const result = approvePlan('Looks good')

      expect(result.success).toBe(true)
      expect(result.plan?.status).toBe('approved')
      expect(result.plan?.userFeedback).toBe('Looks good')

      const check = canExecute()
      expect(check.allowed).toBe(true)
    })

    it('rejects plan and clears current plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      const result = rejectPlan('Need changes')

      expect(result.success).toBe(true)
      expect(getCurrentPlan()).toBeNull()
    })

    it('emits planning:approved event', () => {
      let eventReceived = false
      const bus = getEventBus()
      bus.on('planning:approved', () => {
        eventReceived = true
      })

      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()

      expect(eventReceived).toBe(true)
    })

    it('emits planning:rejected event', () => {
      let eventReceived = false
      const bus = getEventBus()
      bus.on('planning:rejected', () => {
        eventReceived = true
      })

      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      rejectPlan()

      expect(eventReceived).toBe(true)
    })
  })

  describe('canExecute', () => {
    it('allows execution without plan', () => {
      const check = canExecute()
      expect(check.allowed).toBe(true)
      expect(check.reason).toContain('No plan required')
    })

    it('blocks execution for unapproved plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      const check = canExecute()
      expect(check.allowed).toBe(false)
      expect(check.reason).toContain('awaiting approval')
    })

    it('allows execution for approved plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()

      const check = canExecute()
      expect(check.allowed).toBe(true)
    })
  })

  describe('startExecution', () => {
    it('starts execution for approved plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()

      const result = startExecution()

      expect(result.success).toBe(true)
      const plan = getCurrentPlan()
      expect(plan?.status).toBe('executing')
    })

    it('fails for unapproved plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      const result = startExecution()

      expect(result.success).toBe(false)
    })
  })

  describe('completeStep', () => {
    it('marks step as completed', () => {
      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'a.ts', description: 'A', estimatedImpact: 'low', dependencies: [] },
        { action: 'Step 2', target: 'b.ts', description: 'B', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()

      const stepId = plan.strategy[0].id
      const result = completeStep(stepId, 'Done successfully')

      expect(result.success).toBe(true)
      expect(result.nextStep?.action).toBe('Step 2')

      const updatedPlan = getCurrentPlan()
      expect(updatedPlan?.strategy[0].status).toBe('completed')
      expect(updatedPlan?.strategy[0].result).toBe('Done successfully')
    })

    it('completes plan when all steps done', () => {
      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()

      completeStep(plan.strategy[0].id)

      // Plan should be archived and cleared
      expect(getCurrentPlan()).toBeNull()
      expect(getPlanHistory().length).toBe(1)
    })

    it('emits planning:step_completed event', () => {
      let eventData: unknown = null
      const bus = getEventBus()
      bus.on('planning:step_completed', (evt) => {
        eventData = evt
      })

      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()
      completeStep(plan.strategy[0].id)

      expect(eventData).toBeDefined()
    })
  })

  describe('reportBlockedStep', () => {
    it('marks step as blocked', () => {
      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()

      const result = reportBlockedStep(plan.strategy[0].id, 'API not available', 'Use mock instead')

      expect(result.success).toBe(true)

      const updatedPlan = getCurrentPlan()
      expect(updatedPlan?.status).toBe('blocked')
      expect(updatedPlan?.strategy[0].status).toBe('blocked')
      expect(updatedPlan?.strategy[0].blockedReason).toBe('API not available')
    })

    it('emits planning:blocked event', () => {
      let eventData: unknown = null
      const bus = getEventBus()
      bus.on('planning:blocked', (evt) => {
        eventData = evt
      })

      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()
      reportBlockedStep(plan.strategy[0].id, 'Error', 'Alternative')

      expect(eventData).toBeDefined()
    })
  })

  describe('abandonPlan', () => {
    it('abandons and archives plan', () => {
      createPlan('Test', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])

      const result = abandonPlan('No longer needed')

      expect(result.success).toBe(true)
      expect(getCurrentPlan()).toBeNull()
      expect(getPlanHistory().length).toBe(1)
      expect(getPlanHistory()[0].status).toBe('abandoned')
    })
  })

  describe('formatting', () => {
    it('formats plan as draft', () => {
      const plan = createPlan('Test objective', [
        { action: 'Step 1', target: 'file.ts', description: 'First step', estimatedImpact: 'low', dependencies: [] },
      ])

      const formatted = formatPlanAsDraft(plan)

      expect(formatted).toContain('**Objetivo:** Test objective')
      expect(formatted).toContain('**Estratégia Técnica:**')
      expect(formatted).toContain('Passo 1')
      expect(formatted).toContain('**Bloqueio:**')
    })

    it('formats plan status', () => {
      const plan = createPlan('Test', [
        { action: 'Step 1', target: 'a.ts', description: 'A', estimatedImpact: 'low', dependencies: [] },
        { action: 'Step 2', target: 'b.ts', description: 'B', estimatedImpact: 'low', dependencies: [] },
      ])

      const status = formatPlanStatus(plan)

      expect(status).toContain('Plano: Test')
      expect(status).toContain('Status: draft')
      expect(status).toContain('Progresso: 0/2')
    })
  })

  describe('getAgencySystemPromptSection', () => {
    it('returns system prompt section', () => {
      const section = getAgencySystemPromptSection()

      expect(section).toContain('Protocolo de Alta Agência')
      expect(section).toContain('Draft-then-Commit')
      expect(section).toContain('Proibição de Escrita Precoce')
      expect(section).toContain('Auto-Correção')
    })
  })

  describe('history', () => {
    it('tracks plan history', () => {
      const plan = createPlan('Test 1', [
        { action: 'Step 1', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
      ])
      approvePlan()
      completeStep(plan.strategy[0].id)

      const history = getPlanHistory()
      expect(history.length).toBe(1)
      expect(history[0].objective).toBe('Test 1')
      expect(history[0].status).toBe('completed')
      expect(history[0].stepsCompleted).toBe(1)
    })

    it('limits history to requested count', () => {
      // Create and complete multiple plans
      for (let i = 0; i < 5; i++) {
        const plan = createPlan(`Test ${i}`, [
          { action: 'Step', target: 'file.ts', description: 'Do', estimatedImpact: 'low', dependencies: [] },
        ])
        approvePlan()
        completeStep(plan.strategy[0].id)
      }

      const history = getPlanHistory(3)
      expect(history.length).toBe(3)
    })
  })
})
