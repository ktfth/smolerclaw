import type Anthropic from '@anthropic-ai/sdk'
import {
  isVaultInitialized, getVaultStatus, formatVaultStatus,
  performBackup, syncBackupToRemote, initShadowBackup,
} from '../../vault'
import { bindTools, ok, fail, optionalText, type ToolHandler } from '../../core/result'

const SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'vault_status',
    description:
      'Show the integrity status of all data files: checksum verification, sizes, last backup time. ' +
      'Use when the user asks about data health, backup status, or says "esta tudo salvo?", "meus dados estao seguros?".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'vault_backup',
    description:
      'Perform a manual backup of all data to the shadow backup repository. ' +
      'Use when the user says "faz backup", "salva tudo", "sync".',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Optional commit message for the backup.' },
      },
      required: [],
    },
  },
  {
    name: 'sync_cloud_context',
    description:
      'Push the backup to a configured remote repository (if set up). ' +
      'Use when the user says "manda pro cloud", "sync remoto", "push backup".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'vault_init_backup',
    description:
      'Initialize the shadow backup system (creates a local git repo for data versioning). ' +
      'Run once to enable automatic backups.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
]

const NOT_INITIALIZED = fail('Vault não inicializado.')

function withVault(run: ToolHandler): ToolHandler {
  return (input) => (isVaultInitialized() ? run(input) : NOT_INITIALIZED)
}

const HANDLERS: Record<string, ToolHandler> = {
  vault_status: withVault(() => ok(formatVaultStatus(getVaultStatus()))),
  vault_backup: withVault((input) => performBackup(optionalText(input, 'message'))),
  sync_cloud_context: withVault(() => syncBackupToRemote()),
  vault_init_backup: withVault(() => initShadowBackup()),
}

export const VAULT_TOOLS = bindTools(SCHEMAS, HANDLERS, ['vault_status'])
