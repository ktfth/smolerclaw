/**
 * Vault location and containment. smolerclaw owns one subfolder of the
 * Obsidian vault and never reads or writes outside it.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export const OWNED_FOLDER = 'smolerclaw'

export interface VaultRoot {
  /** Real path of the Obsidian vault. */
  vault: string
  /** Real path of the subfolder smolerclaw owns. */
  root: string
}

export type VaultCheck = { ok: true; value: VaultRoot } | { ok: false; error: string }

/**
 * Accept only an absolute, local, existing Obsidian vault (a directory with
 * a `.obsidian/` folder). Creates the owned subfolder when missing.
 */
export function resolveVault(raw: string): VaultCheck {
  const trimmed = raw.trim()
  // Checked before any fs call: resolving an unreachable UNC share can crash the runtime.
  if (/^[\\/]{2}/.test(trimmed)) return { ok: false, error: 'caminhos de rede (UNC) não são aceitos' }
  if (!isAbsolute(trimmed)) return { ok: false, error: `use um caminho absoluto: "${trimmed}"` }

  let vault: string
  try {
    vault = realpathSync.native(trimmed)
  } catch {
    return { ok: false, error: `vault não encontrado: "${trimmed}"` }
  }
  if (/^[\\/]{2}/.test(vault)) return { ok: false, error: 'o vault aponta para um caminho de rede (UNC)' }
  if (!statSync(vault).isDirectory()) return { ok: false, error: `não é uma pasta: "${vault}"` }
  if (!existsSync(join(vault, '.obsidian'))) {
    return { ok: false, error: `não parece um vault do Obsidian (sem .obsidian/): "${vault}"` }
  }

  const owned = join(vault, OWNED_FOLDER)
  try {
    if (!existsSync(owned)) mkdirSync(owned)
    const root = realpathSync.native(owned)
    if (!isInside(vault, root)) return { ok: false, error: `"${OWNED_FOLDER}" aponta para fora do vault` }
    return { ok: true, value: { vault, root } }
  } catch (err) {
    return { ok: false, error: `não foi possível preparar "${owned}": ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Deepest ancestor of `path` that exists on disk. */
function existingAncestor(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Resolve a vault-relative path ("Notas/memo/x.md") to an absolute path that
 * is guaranteed to live under the owned root. Containment is checked on the
 * real path of the deepest existing ancestor before anything is created, and
 * the final component may not be a symlink or junction.
 */
export function ownedPath(vr: VaultRoot, rel: string): string {
  const target = join(vr.root, ...rel.split('/'))
  if (!isInside(vr.root, target)) throw new Error(`caminho fora da pasta do smolerclaw: "${rel}"`)

  const dir = dirname(target)
  if (!isInside(vr.root, realpathSync.native(existingAncestor(dir)))) {
    throw new Error(`caminho escapa da pasta do smolerclaw: "${rel}"`)
  }
  mkdirSync(dir, { recursive: true })
  const realDir = realpathSync.native(dir)
  if (!isInside(vr.root, realDir)) throw new Error(`caminho escapa da pasta do smolerclaw: "${rel}"`)

  const real = join(realDir, target.slice(dir.length + 1))
  if (existsSync(real) && lstatSync(real).isSymbolicLink()) {
    throw new Error(`links não são seguidos: "${rel}"`)
  }
  return real
}

/** Owned-root-relative path with forward slashes, as stored in the manifest. */
export function toRel(vr: VaultRoot, abs: string): string {
  return relative(vr.root, abs).split(sep).join('/')
}
