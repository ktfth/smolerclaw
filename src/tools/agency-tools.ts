/**
 * High Agency / Planning tool schemas and execution.
 */
import type Anthropic from '@anthropic-ai/sdk'
import {
  analyzeTaskImpact, createPlan, addPlanStep, submitPlanForApproval,
  approvePlan, rejectPlan, canExecute, startExecution, completeStep,
  reportBlockedStep, abandonPlan, getCurrentPlan, getPlanHistory,
  formatPlanAsDraft, formatPlanStatus,
  isAgencyEngineInitialized,
  type PlanStep, type Plan, type ImpactAnalysis,
} from '../services/agency-engine'

export const AGENCY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_plan',
    description:
      'Submit a structured implementation plan for user approval. ' +
      'Use this BEFORE executing any non-trivial task that involves: ' +
      '- Multiple file modifications ' +
      '- Architectural decisions ' +
      '- Business logic changes ' +
      '- API integrations ' +
      'The plan must include objective, steps with targets, and risks/assumptions. ' +
      'Execution is BLOCKED until the user approves the plan.',
    input_schema: {
      type: 'object' as const,
      properties: {
        objective: {
          type: 'string',
          description: 'Concise description of the end goal (e.g., "Implement JWT authentication for /api/users")',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'What to do (e.g., "Create middleware")' },
              target: { type: 'string', description: 'Target file or module (e.g., "src/middleware/auth.ts")' },
              description: { type: 'string', description: 'Brief explanation of this step' },
              estimatedImpact: {
                type: 'string',
                enum: ['none', 'low', 'medium', 'high', 'critical'],
                description: 'Risk level of this step. Default: low.',
              },
              dependencies: {
                type: 'array',
                items: { type: 'string' },
                description: 'IDs of steps that must complete first. Optional.',
              },
            },
            required: ['action', 'target', 'description'],
          },
          description: 'Ordered list of implementation steps',
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key assumptions being made (e.g., "JWT secret exists in .env")',
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Potential risks or breaking changes',
        },
      },
      required: ['objective', 'steps'],
    },
  },
  {
    name: 'check_plan_status',
    description:
      'Check if execution is allowed based on the current plan status. ' +
      'Returns whether you can proceed with modifications or need to wait for approval. ' +
      'Use this before any write operation if unsure about plan state.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'report_plan_deviation',
    description:
      'Report that the current execution plan has encountered an obstacle. ' +
      'Use this when you discover something that invalidates the original plan. ' +
      'This STOPS execution and requires proposing an alternative approach. ' +
      'MANDATORY: Always explain what was found and propose a concrete alternative.',
    input_schema: {
      type: 'object' as const,
      properties: {
        step_id: {
          type: 'string',
          description: 'ID of the step that encountered the obstacle. Optional if not in specific step.',
        },
        obstacle: {
          type: 'string',
          description: 'What obstacle was encountered (e.g., "API does not support pagination")',
        },
        impact: {
          type: 'string',
          description: 'How this affects the plan (e.g., "Cannot proceed with step 3")',
        },
        alternative: {
          type: 'string',
          description: 'Proposed alternative approach',
        },
      },
      required: ['obstacle', 'impact', 'alternative'],
    },
  },
  {
    name: 'complete_plan_step',
    description:
      'Mark a plan step as completed and optionally provide the result. ' +
      'Use this after successfully completing each step in the approved plan. ' +
      'This helps track progress and enables checkpoint validation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        step_id: {
          type: 'string',
          description: 'ID of the completed step',
        },
        result: {
          type: 'string',
          description: 'Brief description of what was accomplished. Optional.',
        },
      },
      required: ['step_id'],
    },
  },
  {
    name: 'get_current_plan',
    description:
      'Get the current active plan with its status and progress. ' +
      'Use to review the plan before continuing execution or to show status to user.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'analyze_task_complexity',
    description:
      'Analyze a task description to determine its complexity and whether it requires planning. ' +
      'Returns complexity classification (trivial/simple/moderate/complex/architectural) ' +
      'and whether explicit approval is needed. Use this when unsure if planning is required.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task to analyze',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of files that would be affected. Optional.',
        },
        modules: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of modules/systems that would be affected. Optional.',
        },
      },
      required: ['task'],
    },
  },
]

export async function executeAgencyTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  switch (name) {
    case 'propose_plan': {
      if (!isAgencyEngineInitialized()) {
        return 'Error: Agency engine not initialized. Planning features unavailable.'
      }
      const objective = input.objective as string
      if (!objective?.trim()) return 'Error: objective is required.'

      const rawSteps = input.steps as Array<{
        action: string
        target: string
        description: string
        estimatedImpact?: string
        dependencies?: string[]
      }>
      if (!rawSteps?.length) return 'Error: at least one step is required.'

      const steps = rawSteps.map(s => ({
        action: s.action,
        target: s.target,
        description: s.description,
        estimatedImpact: (s.estimatedImpact || 'low') as 'none' | 'low' | 'medium' | 'high' | 'critical',
        dependencies: s.dependencies || [],
      }))

      const plan = createPlan(objective, steps, {
        assumptions: input.assumptions as string[] | undefined,
        risks: input.risks as string[] | undefined,
      })

      // Auto-submit for approval
      const result = await submitPlanForApproval()
      if (!result.success) {
        return `Error creating plan: ${result.message}`
      }

      const draft = formatPlanAsDraft(plan)
      return `Plano criado e aguardando aprovação.\n\n${draft}`
    }

    case 'check_plan_status': {
      if (!isAgencyEngineInitialized()) {
        return 'Agency engine not initialized. All operations allowed (no planning enforcement).'
      }
      const check = canExecute()
      const plan = getCurrentPlan()

      if (!plan) {
        return 'Nenhum plano ativo. Operações triviais permitidas sem planejamento.'
      }

      const status = formatPlanStatus(plan)
      return `${status}\n\nExecução: ${check.allowed ? 'PERMITIDA' : 'BLOQUEADA'}\nMotivo: ${check.reason}`
    }

    case 'report_plan_deviation': {
      if (!isAgencyEngineInitialized()) {
        return 'Error: Agency engine not initialized.'
      }
      const obstacle = input.obstacle as string
      const impact = input.impact as string
      const alternative = input.alternative as string

      if (!obstacle?.trim()) return 'Error: obstacle is required.'
      if (!impact?.trim()) return 'Error: impact is required.'
      if (!alternative?.trim()) return 'Error: alternative is required.'

      const plan = getCurrentPlan()
      if (!plan) {
        return 'Nenhum plano ativo. Não há desvio a reportar.'
      }

      const stepId = input.step_id as string | undefined
      const currentStep = stepId
        ? plan.strategy.find(s => s.id === stepId)
        : plan.strategy.find(s => s.status === 'in_progress' || s.status === 'pending')

      if (currentStep) {
        reportBlockedStep(currentStep.id, obstacle, alternative)
      }

      return [
        '**Desvio Detectado**',
        '',
        `**Obstáculo:** ${obstacle}`,
        `**Impacto no Plano:** ${impact}`,
        '',
        '**Alternativa Proposta:**',
        alternative,
        '',
        '**Status:** Execução BLOQUEADA. Aguardando aprovação da alternativa.',
        '',
        '**Bloqueio:** Posso prosseguir com esta alternativa?',
      ].join('\n')
    }

    case 'complete_plan_step': {
      if (!isAgencyEngineInitialized()) {
        return 'Error: Agency engine not initialized.'
      }
      const stepId = input.step_id as string
      if (!stepId?.trim()) return 'Error: step_id is required.'

      const result = completeStep(stepId, input.result as string | undefined)
      if (!result.success) return `Error: ${result.message}`

      const plan = getCurrentPlan()
      const progressMsg = plan
        ? `Progresso: ${plan.strategy.filter(s => s.status === 'completed').length}/${plan.strategy.length}`
        : ''

      const nextMsg = result.nextStep
        ? `\nPróximo passo: ${result.nextStep.action} → ${result.nextStep.target}`
        : '\nTodos os passos concluídos!'

      return `Passo concluído: ${result.message}\n${progressMsg}${nextMsg}`
    }

    case 'get_current_plan': {
      if (!isAgencyEngineInitialized()) {
        return 'Agency engine not initialized. No planning features available.'
      }
      const plan = getCurrentPlan()
      if (!plan) {
        return 'Nenhum plano ativo no momento.'
      }
      return formatPlanAsDraft(plan)
    }

    case 'analyze_task_complexity': {
      if (!isAgencyEngineInitialized()) {
        return 'Agency engine not initialized. Cannot analyze complexity.'
      }
      const task = input.task as string
      if (!task?.trim()) return 'Error: task is required.'

      const analysis = analyzeTaskImpact(task, {
        files: input.files as string[] | undefined,
        modules: input.modules as string[] | undefined,
      })

      const lines = [
        `**Análise de Complexidade**`,
        '',
        `**Tarefa:** ${task}`,
        `**Classificação:** ${analysis.complexity}`,
        `**Requer Aprovação:** ${analysis.requiresApproval ? 'SIM' : 'NÃO'}`,
        '',
        `**Motivo:** ${analysis.reason}`,
      ]

      if (analysis.risks.length > 0) {
        lines.push('', '**Riscos Identificados:**')
        for (const risk of analysis.risks) {
          lines.push(`  - ${risk}`)
        }
      }

      if (analysis.assumptions.length > 0) {
        lines.push('', '**Premissas:**')
        for (const assumption of analysis.assumptions) {
          lines.push(`  - ${assumption}`)
        }
      }

      if (analysis.requiresApproval) {
        lines.push('', '**Recomendação:** Use `propose_plan` antes de executar esta tarefa.')
      }

      return lines.join('\n')
    }

    default:
      return null
  }
}
