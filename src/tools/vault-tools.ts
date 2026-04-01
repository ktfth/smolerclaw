/**
 * Vault tool schemas and execution.
 */
import type Anthropic from '@anthropic-ai/sdk'
import {
  getVaultStatus, formatVaultStatus,
  initShadowBackup, performBackup, syncBackupToRemote,
  isVaultInitialized,
} from '../vault'

export const VAULT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'vault_status',
    description:
      'Show the integrity status of all data files: checksum verification, sizes, last backup time. ' +
      'Use when the user asks about data health, backup status, or says "esta tudo salvo?", "meus dados estao seguros?".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
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
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'vault_init_backup',
    description:
      'Initialize the shadow backup system (creates a local git repo for data versioning). ' +
      'Run once to enable automatic backups.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

export async function executeVaultTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  switch (name) {
    case 'vault_status': {
      if (!isVaultInitialized()) return 'Vault nao inicializado.'
      return formatVaultStatus(getVaultStatus())
    }
    case 'vault_backup': {
      if (!isVaultInitialized()) return 'Vault nao inicializado.'
      const msg = (input.message as string) || undefined
      return await performBackup(msg)
    }
    case 'sync_cloud_context': {
      if (!isVaultInitialized()) return 'Vault nao inicializado.'
      return await syncBackupToRemote()
    }
    case 'vault_init_backup': {
      if (!isVaultInitialized()) return 'Vault nao inicializado.'
      return await initShadowBackup()
    }
    default:
      return null
  }
}
