import type Anthropic from '@anthropic-ai/sdk'
import {
  scheduleJob, removeJob, enableJob, disableJob, listJobs, runJobNow,
  formatJobList, parseScheduleTime, parseScheduleDate, parseWeekDay,
  type ScheduleType,
} from '../../scheduler'
import { bindTools, ok, fail, requireText, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'schedule_job',
    description:
      'Create a persistent scheduled job using Windows Task Scheduler. ' +
      'Jobs fire even when smolerclaw is not running. ' +
      'Supports one-time, daily, and weekly schedules.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name for the job' },
        time: { type: 'string', description: 'Time in HH:MM format (e.g., "14:00", "09:30")' },
        message: { type: 'string', description: 'Message to display in the notification' },
        schedule_type: {
          type: 'string',
          enum: ['once', 'daily', 'weekly'],
          description: 'Schedule type: once (single execution), daily, or weekly. Default: once',
        },
        date_or_day: {
          type: 'string',
          description: 'For "once": date in DD/MM/YYYY format or "hoje"/"amanha". For "weekly": day name (e.g., "segunda", "friday"). Optional.',
        },
      },
      required: ['name', 'time', 'message'],
    },
  },
  {
    name: 'remove_scheduled_job',
    description: 'Remove a scheduled job by its ID or name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'list_scheduled_jobs',
    description: 'List all scheduled jobs. Shows name, schedule, and status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_disabled: { type: 'boolean', description: 'Include disabled jobs. Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'enable_scheduled_job',
    description: 'Enable a previously disabled scheduled job.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'disable_scheduled_job',
    description: 'Disable a scheduled job without removing it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'run_scheduled_job_now',
    description: 'Execute a scheduled job immediately (for testing).',
    input_schema: {
      type: 'object' as const,
      properties: {
        reference: { type: 'string', description: 'Job ID or partial name to match' },
      },
      required: ['reference'],
    },
  },
]

/** Next occurrence of HH:MM as MM/DD/YYYY (the schtasks date format). */
function nextOccurrence(time: string, now: Date): string {
  const [h, m] = time.split(':').map(Number)
  const at = new Date(now)
  at.setHours(h, m, 0, 0)
  if (at <= now) at.setDate(at.getDate() + 1)
  return [
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
    String(at.getFullYear()),
  ].join('/')
}

const HANDLERS: Record<string, ToolHandler> = {
  schedule_job: async (input) => {
    const name = requireText(input, 'name')
    const timeStr = requireText(input, 'time')
    const message = requireText(input, 'message')
    if (!name || !timeStr || !message) return fail('name, time, and message are required.')
    const parsedTime = parseScheduleTime(timeStr)
    if (!parsedTime) return fail(`invalid time format "${timeStr}". Use HH:MM.`)

    const schedType = (input.schedule_type as ScheduleType) || 'once'
    const raw = requireText(input, 'date_or_day')
    let dateOrDay: string | undefined
    if (raw) {
      dateOrDay = (schedType === 'weekly' ? parseWeekDay(raw) : parseScheduleDate(raw)) ?? undefined
      if (!dateOrDay) return fail(`could not parse date_or_day "${raw}".`)
    }
    if (schedType === 'once' && !dateOrDay) dateOrDay = nextOccurrence(parsedTime, new Date())

    const job = await scheduleJob(name, schedType, parsedTime, 'toast', message, dateOrDay)
    return ok(`Agendamento criado: "${job.name}" [${job.id}] — ${job.scheduleType} às ${job.time}`, job)
  },
  remove_scheduled_job: async (input) => {
    const ref = requireText(input, 'reference')
    if (!ref) return fail('reference is required.')
    return (await removeJob(ref)) ? ok('Agendamento removido.') : fail(`Agendamento não encontrado: "${ref}"`)
  },
  list_scheduled_jobs: (input) => {
    const jobs = listJobs(input.include_disabled === true)
    return ok(formatJobList(jobs), jobs)
  },
  enable_scheduled_job: async (input) => {
    const ref = requireText(input, 'reference')
    if (!ref) return fail('reference is required.')
    const job = await enableJob(ref)
    return job ? ok(`Agendamento "${job.name}" ativado.`, job) : fail(`Agendamento não encontrado, já ativo ou com data vencida: "${ref}"`)
  },
  disable_scheduled_job: async (input) => {
    const ref = requireText(input, 'reference')
    if (!ref) return fail('reference is required.')
    const job = await disableJob(ref)
    return job ? ok(`Agendamento "${job.name}" desativado.`, job) : fail(`Agendamento não encontrado ou já inativo: "${ref}"`)
  },
  run_scheduled_job_now: async (input) => {
    const ref = requireText(input, 'reference')
    if (!ref) return fail('reference is required.')
    return runJobNow(ref)
  },
}

export const SCHEDULER_TOOLS = bindTools(
  SCHEMAS,
  HANDLERS,
  ['list_scheduled_jobs'],
  { destructive: ['remove_scheduled_job'] },
)
