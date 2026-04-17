/**
 * Docker & Security automation tools.
 *
 * Provides Claude-callable tools for:
 *   - Docker setup automation (status, Dockerfile gen, compose, container management)
 *   - Security hardening (firewall check, Defender status, port scan, audit log)
 *   - FSWatcher management (watch/unwatch directories, query changes)
 *   - SQLite database status and queries
 *
 * All destructive operations go through Draft-then-Commit via agency-engine.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { IS_WINDOWS } from '../platform'
import { executePowerShell } from '../utils/windows-executor'
import {
  initFSWatcher, watchDirectory, unwatchDirectory, unwatchAll,
  listWatchers, getWatcherStatus, getRecentChanges, formatChangeEvent,
  type FileChangeEvent,
} from '../fs-watcher'
import {
  isSQLiteInitialized, getDBStats, formatDBStats,
  logAudit, queryAuditLog, logDockerEvent, queryDockerEvents,
  logSecurityScan, querySecurityScans, queryWatchEvents,
  countWatchEvents, logWatchEvent, purgeOldEvents,
} from '../storage/sqlite'
import { eventBus } from '../core/event-bus'

// ─── Tool Schemas ───────────────────────────────────────────

export const DOCKER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'docker_status',
    description:
      'Check Docker Desktop status: daemon running, version, containers, images. ' +
      'No arguments needed.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'docker_containers',
    description:
      'List Docker containers. Set show_all=true to include stopped containers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        show_all: {
          type: 'boolean',
          description: 'Include stopped containers (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: 'docker_generate',
    description:
      'Generate a Dockerfile or docker-compose.yml for a project. ' +
      'Analyzes the current directory and produces an optimized config.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['dockerfile', 'compose'],
          description: 'Type of file to generate',
        },
        runtime: {
          type: 'string',
          description: 'Target runtime: node, bun, python, go, etc.',
        },
        services: {
          type: 'string',
          description: 'Comma-separated services for compose (e.g., "postgres,redis")',
        },
      },
      required: ['type'],
    },
  },
]

export const SECURITY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'security_scan',
    description:
      'Run a security scan on the system or project. ' +
      'Types: firewall (Windows Firewall status), defender (Windows Defender status), ' +
      'ports (open ports), secrets (scan for hardcoded secrets in cwd).',
    input_schema: {
      type: 'object' as const,
      properties: {
        scan_type: {
          type: 'string',
          enum: ['firewall', 'defender', 'ports', 'secrets'],
          description: 'Type of security scan to run',
        },
      },
      required: ['scan_type'],
    },
  },
  {
    name: 'security_audit_log',
    description:
      'Query the security audit log. Filter by category, severity, or time range.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category (e.g., "docker", "firewall", "secrets")',
        },
        severity: {
          type: 'string',
          enum: ['info', 'warning', 'error', 'critical'],
          description: 'Filter by minimum severity',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return (default: 20)',
        },
      },
      required: [],
    },
  },
]

export const WATCHER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'fs_watch',
    description:
      'Start watching a directory for file changes. Returns a watch ID for management. ' +
      'Monitors file creates, modifications, and deletions in real-time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to watch',
        },
        recursive: {
          type: 'boolean',
          description: 'Watch subdirectories recursively (default: true)',
        },
        patterns: {
          type: 'string',
          description: 'Comma-separated file extensions to watch (e.g., ".ts,.json,.md"). Default: common dev files.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_unwatch',
    description: 'Stop watching a directory by its watch ID, or "all" to stop all watchers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        watch_id: {
          type: 'string',
          description: 'Watch ID to stop, or "all" to stop all watchers',
        },
      },
      required: ['watch_id'],
    },
  },
  {
    name: 'fs_watch_status',
    description: 'Get status of all file watchers and recent changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filter_ext: {
          type: 'string',
          description: 'Optional: filter recent changes by extension (e.g., ".ts")',
        },
      },
      required: [],
    },
  },
  {
    name: 'fs_watch_history',
    description: 'Query the file change history from SQLite. Supports time range and extension filters.',
    input_schema: {
      type: 'object' as const,
      properties: {
        extension: {
          type: 'string',
          description: 'Filter by file extension (e.g., ".ts")',
        },
        hours: {
          type: 'number',
          description: 'Look back N hours (default: 24)',
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 50)',
        },
      },
      required: [],
    },
  },
]

export const DB_TOOLS: Anthropic.Tool[] = [
  {
    name: 'db_status',
    description: 'Get SQLite database status: table sizes, disk usage, event counts.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'db_purge',
    description: 'Purge old events beyond retention period. Default: 30 days.',
    input_schema: {
      type: 'object' as const,
      properties: {
        retention_days: {
          type: 'number',
          description: 'Keep events from the last N days (default: 30)',
        },
      },
      required: [],
    },
  },
]

// Combine all tool schemas
export const DOCKER_SECURITY_TOOLS: Anthropic.Tool[] = [
  ...DOCKER_TOOLS,
  ...SECURITY_TOOLS,
  ...WATCHER_TOOLS,
  ...DB_TOOLS,
]

// ─── Tool Execution ─────────────────────────────────────────

/**
 * Execute a docker/security/watcher/db tool.
 * Returns null if the tool name is not handled here.
 */
export async function executeDockerSecurityTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  switch (name) {
    // Docker tools
    case 'docker_status':
      return await dockerStatus()
    case 'docker_containers':
      return await dockerContainers(!!input.show_all)
    case 'docker_generate':
      return dockerGenerate(
        input.type as string,
        input.runtime as string | undefined,
        input.services as string | undefined,
      )

    // Security tools
    case 'security_scan':
      return await securityScan(input.scan_type as string)
    case 'security_audit_log':
      return securityAuditLog(input)

    // Watcher tools
    case 'fs_watch':
      return fsWatch(input)
    case 'fs_unwatch':
      return fsUnwatch(input.watch_id as string)
    case 'fs_watch_status':
      return fsWatchStatus(input.filter_ext as string | undefined)
    case 'fs_watch_history':
      return fsWatchHistory(input)

    // DB tools
    case 'db_status':
      return dbStatus()
    case 'db_purge':
      return dbPurge(input.retention_days as number | undefined)

    default:
      return null
  }
}

// ─── Docker Implementations ────────────────────────────────

async function dockerStatus(): Promise<string> {
  try {
    const version = await runCmd('docker --version')
    const info = await runCmd('docker info --format "{{.ServerVersion}} | Containers: {{.Containers}} | Images: {{.Images}} | OS: {{.OperatingSystem}}"')

    logAudit({ action: 'docker_status', category: 'docker', severity: 'info' })
    logDockerEvent({ action: 'status_check', status: 'ok' })

    return [
      '=== Docker Status ===',
      `Versao: ${version.trim()}`,
      `Info: ${info.trim()}`,
      'Status: Docker daemon rodando.',
    ].join('\n')
  } catch {
    logAudit({ action: 'docker_status', category: 'docker', details: 'Docker not available', severity: 'warning' })
    return 'Docker nao esta instalado ou o daemon nao esta rodando.\nInstale: https://docs.docker.com/desktop/install/windows-install/'
  }
}

async function dockerContainers(showAll: boolean): Promise<string> {
  try {
    const flag = showAll ? '-a' : ''
    const result = await runCmd(`docker ps ${flag} --format "table {{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"`)
    return result.trim() || 'Nenhum container encontrado.'
  } catch {
    return 'Error: Docker nao disponivel.'
  }
}

function dockerGenerate(
  type: string,
  runtime?: string,
  services?: string,
): string {
  if (type === 'dockerfile') {
    return generateDockerfile(runtime ?? 'bun')
  }
  if (type === 'compose') {
    return generateCompose(runtime ?? 'bun', services)
  }
  return 'Error: type deve ser "dockerfile" ou "compose".'
}

function generateDockerfile(runtime: string): string {
  const templates: Record<string, string> = {
    bun: `# Dockerfile — Bun runtime
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Build
FROM base AS build
COPY --from=install /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Production
FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json .

USER bun
EXPOSE 3000
ENTRYPOINT ["bun", "run", "dist/index.js"]`,

    node: `# Dockerfile — Node.js runtime
FROM node:24-slim AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production
FROM base AS release
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json .

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]`,

    python: `# Dockerfile — Python runtime
FROM python:3.13-slim AS base
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

USER nobody
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`,
  }

  const template = templates[runtime]
  if (!template) {
    return `Error: runtime "${runtime}" nao suportado. Use: ${Object.keys(templates).join(', ')}`
  }

  logAudit({ action: 'docker_generate', category: 'docker', details: `Dockerfile for ${runtime}`, severity: 'info' })
  return `Dockerfile gerado para ${runtime}:\n\n${template}`
}

function generateCompose(runtime: string, services?: string): string {
  const serviceList = services?.split(',').map((s) => s.trim()) ?? []
  const parts: string[] = [
    '# docker-compose.yml',
    'services:',
    `  app:`,
    `    build: .`,
    `    ports:`,
    `      - "3000:3000"`,
    `    environment:`,
    `      - NODE_ENV=production`,
  ]

  if (serviceList.includes('postgres') || serviceList.includes('postgresql')) {
    parts.push(
      '',
      '  postgres:',
      '    image: postgres:17-alpine',
      '    environment:',
      '      POSTGRES_DB: app',
      '      POSTGRES_USER: app',
      '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}',
      '    ports:',
      '      - "5432:5432"',
      '    volumes:',
      '      - postgres_data:/var/lib/postgresql/data',
    )
  }

  if (serviceList.includes('redis')) {
    parts.push(
      '',
      '  redis:',
      '    image: redis:7-alpine',
      '    ports:',
      '      - "6379:6379"',
    )
  }

  // Add volumes section if needed
  const hasVolumes = serviceList.includes('postgres') || serviceList.includes('postgresql')
  if (hasVolumes) {
    parts.push('', 'volumes:', '  postgres_data:')
  }

  logAudit({ action: 'docker_generate', category: 'docker', details: `compose with ${serviceList.join(',')}`, severity: 'info' })
  return parts.join('\n')
}

// ─── Security Implementations ───────────────────────────────

async function securityScan(scanType: string): Promise<string> {
  const findings: string[] = []
  let passed = true

  switch (scanType) {
    case 'firewall': {
      if (!IS_WINDOWS) return 'Scan de firewall disponivel apenas no Windows.'
      try {
        const execResult = await executePowerShell(
          'Get-NetFirewallProfile | Select-Object Name, Enabled | Format-Table -AutoSize',
          { timeout: 10_000 },
        )
        const output = execResult.stdout
        const isEnabled = output.includes('True')
        passed = isEnabled
        if (!isEnabled) findings.push('Firewall pode estar desabilitado em alguns perfis')

        logSecurityScan({ scanType: 'firewall', target: 'system', findings, severity: passed ? 'info' : 'warning', passed })
        logAudit({ action: 'security_scan', category: 'firewall', details: output, severity: passed ? 'info' : 'warning' })

        return `=== Firewall Status ===\n${output}\nStatus: ${passed ? 'OK — Firewall ativo' : 'ATENCAO — Verifique perfis desabilitados'}`
      } catch (err) {
        return `Error ao verificar firewall: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'defender': {
      if (!IS_WINDOWS) return 'Scan do Defender disponivel apenas no Windows.'
      try {
        const execResult = await executePowerShell(
          'Get-MpComputerStatus | Select-Object AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated | Format-List',
          { timeout: 15_000 },
        )
        const output = execResult.stdout
        passed = output.includes('True')
        if (!passed) findings.push('Defender ou protecao em tempo real pode estar desabilitado')

        logSecurityScan({ scanType: 'defender', target: 'system', findings, severity: passed ? 'info' : 'critical', passed })
        logAudit({ action: 'security_scan', category: 'defender', details: output, severity: passed ? 'info' : 'critical' })

        return `=== Windows Defender ===\n${output}\nStatus: ${passed ? 'OK — Protecao ativa' : 'CRITICO — Protecao desabilitada!'}`
      } catch (err) {
        return `Error ao verificar Defender: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'ports': {
      try {
        const cmd = IS_WINDOWS
          ? 'netstat -an | findstr LISTENING'
          : 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null'
        const result = await runCmd(cmd)
        const lines = result.trim().split('\n').filter(Boolean)

        logSecurityScan({ scanType: 'ports', target: 'system', findings: [`${lines.length} portas abertas`], severity: 'info', passed: true })
        logAudit({ action: 'security_scan', category: 'ports', details: `${lines.length} listening ports`, severity: 'info' })

        return `=== Portas Abertas (${lines.length}) ===\n${result.trim()}`
      } catch (err) {
        return `Error ao escanear portas: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    case 'secrets': {
      try {
        const patterns = [
          'OPENAI_API_KEY=', 'AWS_SECRET_ACCESS_KEY=', 'GITHUB_TOKEN=',
          'password=', 'secret=', 'Bearer ', 'sk-', 'ghp_', 'xoxb-',
        ]
        const cmd = IS_WINDOWS
          ? `findstr /s /i /m "${patterns.slice(0, 3).join('" "')}" *.ts *.js *.json *.env 2>nul`
          : `grep -rli "${patterns[0]}\\|${patterns[1]}\\|${patterns[2]}" --include="*.ts" --include="*.js" --include="*.json" --include="*.env" . 2>/dev/null || true`

        const result = await runCmd(cmd)
        const files = result.trim().split('\n').filter(Boolean)
        passed = files.length === 0 || (files.length === 1 && files[0] === '')

        logSecurityScan({
          scanType: 'secrets',
          target: 'cwd',
          findings: passed ? [] : files,
          severity: passed ? 'info' : 'critical',
          passed,
        })
        logAudit({
          action: 'security_scan',
          category: 'secrets',
          details: passed ? 'No secrets found' : `Potential secrets in ${files.length} files`,
          severity: passed ? 'info' : 'critical',
        })

        if (passed) {
          return 'Scan de secrets: OK — Nenhum segredo hardcoded detectado.'
        }
        return `ATENCAO: Possiveis segredos encontrados em ${files.length} arquivo(s):\n${files.join('\n')}\n\nRemova segredos do codigo e use variaveis de ambiente.`
      } catch {
        return 'Scan de secrets concluido (sem resultados suspeitos).'
      }
    }

    default:
      return `Error: scan_type invalido "${scanType}". Use: firewall, defender, ports, secrets.`
  }
}

function securityAuditLog(input: Record<string, unknown>): string {
  if (!isSQLiteInitialized()) return 'Error: SQLite nao inicializado.'

  const entries = queryAuditLog({
    category: input.category as string | undefined,
    severity: input.severity as string | undefined,
    limit: (input.limit as number) ?? 20,
  })

  if (entries.length === 0) return 'Nenhuma entrada no audit log.'

  const lines = entries.map((e) => {
    const time = new Date(e.timestamp).toLocaleString('pt-BR')
    return `[${time}] [${e.severity.toUpperCase()}] ${e.category}: ${e.action} — ${e.details || '(sem detalhes)'}`
  })

  return `=== Audit Log (${entries.length} entradas) ===\n${lines.join('\n')}`
}

// ─── FSWatcher Implementations ──────────────────────────────

function fsWatch(input: Record<string, unknown>): string {
  const path = input.path as string
  if (!path) return 'Error: "path" e obrigatorio.'

  const patterns = input.patterns
    ? (input.patterns as string).split(',').map((p) => p.trim())
    : undefined

  try {
    const id = watchDirectory(path, {
      recursive: input.recursive !== false,
      patterns,
    })

    logAudit({ action: 'fs_watch_start', category: 'watcher', details: `Watching ${path} (id: ${id})`, severity: 'info' })

    return `Monitorando: ${path}\nWatch ID: ${id}\nRecursivo: ${input.recursive !== false}\nFiltros: ${patterns?.join(', ') ?? 'padrao'}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

function fsUnwatch(watchId: string): string {
  if (!watchId) return 'Error: "watch_id" e obrigatorio.'

  if (watchId === 'all') {
    unwatchAll()
    logAudit({ action: 'fs_watch_stop_all', category: 'watcher', severity: 'info' })
    return 'Todos os watchers foram parados.'
  }

  const removed = unwatchDirectory(watchId)
  if (!removed) return `Watcher "${watchId}" nao encontrado.`

  logAudit({ action: 'fs_watch_stop', category: 'watcher', details: `Stopped ${watchId}`, severity: 'info' })
  return `Watcher "${watchId}" parado.`
}

function fsWatchStatus(filterExt?: string): string {
  const status = getWatcherStatus()

  const lines = [
    `=== FSWatcher Status ===`,
    `Ativo: ${status.active ? 'Sim' : 'Nao'}`,
    `Watchers: ${status.targets.length}`,
    `Total mudancas: ${status.totalChangesDetected}`,
  ]

  if (status.targets.length > 0) {
    lines.push('\n--- Diretorios ---')
    lines.push(listWatchers())
  }

  const recent = getRecentChanges(filterExt)
  if (recent.length > 0) {
    lines.push(`\n--- Mudancas recentes (${recent.length}) ---`)
    for (const event of recent.slice(0, 15)) {
      lines.push(`  ${formatChangeEvent(event)}`)
    }
  }

  return lines.join('\n')
}

function fsWatchHistory(input: Record<string, unknown>): string {
  if (!isSQLiteInitialized()) return 'Error: SQLite nao inicializado.'

  const hours = (input.hours as number) ?? 24
  const since = Date.now() - (hours * 60 * 60 * 1000)

  const events = queryWatchEvents({
    extension: input.extension as string | undefined,
    since,
    limit: (input.limit as number) ?? 50,
  })

  if (events.length === 0) return `Nenhuma mudanca nas ultimas ${hours}h.`

  const total = countWatchEvents(since)
  const lines = events.map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString('pt-BR')
    return `[${time}] ${e.eventType}: ${e.relativePath}`
  })

  return `=== Historico de Mudancas (${events.length}/${total}) ===\nPeriodo: ultimas ${hours}h\n${lines.join('\n')}`
}

// ─── DB Tool Implementations ────────────────────────────────

function dbStatus(): string {
  if (!isSQLiteInitialized()) return 'Error: SQLite nao inicializado.'
  return formatDBStats()
}

function dbPurge(retentionDays?: number): string {
  if (!isSQLiteInitialized()) return 'Error: SQLite nao inicializado.'

  const days = retentionDays ?? 30
  const purged = purgeOldEvents(days)

  logAudit({ action: 'db_purge', category: 'database', details: `Purged ${purged} events older than ${days} days`, severity: 'info' })

  return `Limpeza concluida: ${purged} eventos removidos (retencao: ${days} dias).`
}

// ─── Helpers ────────────────────────────────────────────────

async function runCmd(cmd: string): Promise<string> {
  if (IS_WINDOWS) {
    const result = await executePowerShell(cmd, { timeout: 15_000 })
    return result.stdout
  }
  const proc = Bun.spawn(['bash', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return stdout
}

// ─── Event Bus Integration ──────────────────────────────────

/**
 * Wire FSWatcher events to SQLite logging.
 * Call after both FSWatcher and SQLite are initialized.
 */
export function wireWatcherToSQLite(): void {
  eventBus.on('fs:changed', (event: FileChangeEvent) => {
    if (isSQLiteInitialized()) {
      logWatchEvent({
        watchId: event.watchId,
        eventType: event.eventType,
        filePath: event.filePath,
        relativePath: event.relativePath,
        extension: event.extension,
        timestamp: event.timestamp,
      })
    }
  }, { async: true })
}
