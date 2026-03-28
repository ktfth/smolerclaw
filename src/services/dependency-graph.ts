/**
 * Blast Radius Analysis — lightweight dependency graph for TypeScript projects.
 *
 * Builds an import/export graph from .ts/.tsx files using regex-based parsing
 * (no AST parser dependency). Computes:
 *   - Direct dependents: files that import the target
 *   - Transitive dependents: files affected through the full import chain
 *   - Refactor ordering: safe update sequence (leaves-out, target first)
 *
 * Ignores node_modules, dist, build, .git, etc. via platform.ts excludes.
 */

import { readdirSync, readFileSync, statSync, lstatSync } from 'node:fs'
import { join, resolve, relative, dirname, extname } from 'node:path'
import { SEARCH_EXCLUDES } from '../platform'

// ─── Types ──────────────────────────────────────────────────

export interface DependencyGraph {
  imports: Map<string, Set<string>>
  importedBy: Map<string, Set<string>>
  files: string[]
  root: string
}

export interface BlastRadius {
  target: string
  directDependents: string[]
  transitiveDependents: string[]
  depthMap: Map<string, number>   // file → depth from target
  totalAffected: number
  depth: number
  tree: DependencyNode
}

export interface DependencyNode {
  file: string
  depth: number
  children: DependencyNode[]
}

export interface RefactorPlan {
  target: string
  order: RefactorStep[]
  totalFiles: number
}

export interface RefactorStep {
  file: string
  depth: number
  dependsOn: string[]
}

// ─── Constants ──────────────────────────────────────────────

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '/index.ts', '/index.tsx']
const EXCLUDE_DIRS = new Set(SEARCH_EXCLUDES)
const MAX_FILES = 5000         // safety cap for filesystem traversal
const CACHE_TTL_MS = 5_000     // graph cache TTL

// ─── Graph Cache ────────────────────────────────────────────

const _graphCache = new Map<string, { graph: DependencyGraph; ts: number }>()

function getCachedGraph(root: string): DependencyGraph | null {
  const cached = _graphCache.get(root)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.graph
  return null
}

function setCachedGraph(root: string, graph: DependencyGraph): void {
  _graphCache.set(root, { graph, ts: Date.now() })
}

// ─── Import Parsing (regex-based) ───────────────────────────

const IMPORT_PATTERNS: RegExp[] = [
  // Static imports: import [type] ... from '...' — [^'"]* prevents crossing quotes
  /^import\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm,
  // Side-effect imports: import '...'
  /^import\s+['"]([^'"]+)['"]/gm,
  // Re-exports: export [type] {..} from '...' or export * from '...'
  /^export\s+(?:type\s+)?(?:\*|{[^}]*})\s+from\s+['"]([^'"]+)['"]/gm,
  // Dynamic imports: import('...')
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Require: require('...')
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function extractImports(source: string): string[] {
  const specifiers = new Set<string>()

  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(cleaned)) !== null) {
      const specifier = match[1]
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        specifiers.add(specifier)
      }
    }
  }

  return [...specifiers]
}

// ─── File Discovery ─────────────────────────────────────────

function discoverFiles(dir: string): string[] {
  const results: string[] = []

  function walk(current: string): void {
    if (results.length >= MAX_FILES) return

    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= MAX_FILES) return
      if (EXCLUDE_DIRS.has(entry)) continue

      const full = join(current, entry)

      // Use lstatSync to detect symlinks (avoids cycles)
      let lstat
      try {
        lstat = lstatSync(full)
      } catch {
        continue
      }

      if (lstat.isSymbolicLink()) continue

      if (lstat.isDirectory()) {
        walk(full)
      } else if (lstat.isFile() && TS_EXTENSIONS.includes(extname(entry))) {
        results.push(full)
      }
    }
  }

  walk(dir)
  return results
}

// ─── Module Resolution ──────────────────────────────────────

function resolveImport(specifier: string, fromFile: string, allFiles: Set<string>): string | null {
  const dir = dirname(fromFile)
  const base = resolve(dir, specifier)

  if (allFiles.has(base)) return base

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext
    if (allFiles.has(candidate)) return candidate
  }

  return null
}

// ─── Graph Construction ─────────────────────────────────────

export function buildDependencyGraph(rootDir: string): DependencyGraph {
  const root = resolve(rootDir)

  const cached = getCachedGraph(root)
  if (cached) return cached

  const files = discoverFiles(root)
  const fileSet = new Set(files)
  const imports = new Map<string, Set<string>>()
  const importedBy = new Map<string, Set<string>>()

  for (const file of files) {
    imports.set(file, new Set())
    importedBy.set(file, new Set())
  }

  for (const file of files) {
    let source: string
    try {
      source = readFileSync(file, 'utf-8')
    } catch {
      continue
    }

    const specifiers = extractImports(source)
    const fileImports = imports.get(file)!

    for (const specifier of specifiers) {
      const resolved = resolveImport(specifier, file, fileSet)
      if (resolved) {
        fileImports.add(resolved)
        const reverseSet = importedBy.get(resolved) || new Set()
        reverseSet.add(file)
        importedBy.set(resolved, reverseSet)
      }
    }
  }

  const graph: DependencyGraph = { imports, importedBy, files, root }
  setCachedGraph(root, graph)
  return graph
}

// ─── Impact Calculator ──────────────────────────────────────

export function calculateBlastRadius(
  graph: DependencyGraph,
  targetPath: string,
): BlastRadius {
  const target = resolve(targetPath)

  const directSet = graph.importedBy.get(target) || new Set<string>()
  const directDependents = [...directSet]

  // BFS for all dependents (direct + transitive)
  const visited = new Set<string>([target])
  const queue: Array<{ file: string; depth: number }> = []
  const depthMap = new Map<string, number>()
  let maxDepth = 0

  for (const dep of directSet) {
    queue.push({ file: dep, depth: 1 })
    visited.add(dep)
    depthMap.set(dep, 1)
  }

  const transitiveOnly: string[] = []
  let head = 0

  while (head < queue.length) {
    const { file, depth } = queue[head++]
    if (depth > maxDepth) maxDepth = depth

    if (!directSet.has(file)) {
      transitiveOnly.push(file)
    }

    const nextLevel = graph.importedBy.get(file) || new Set()
    for (const next of nextLevel) {
      if (!visited.has(next)) {
        visited.add(next)
        depthMap.set(next, depth + 1)
        queue.push({ file: next, depth: depth + 1 })
      }
    }
  }

  const tree = buildTree(target, graph.importedBy, new Set(), 0)
  const rel = (f: string) => relative(graph.root, f).replace(/\\/g, '/')

  // Convert depthMap keys to relative
  const relDepthMap = new Map<string, number>()
  for (const [file, depth] of depthMap) {
    relDepthMap.set(rel(file), depth)
  }

  return {
    target: rel(target),
    directDependents: directDependents.map(rel),
    transitiveDependents: transitiveOnly.map(rel),
    depthMap: relDepthMap,
    totalAffected: directDependents.length + transitiveOnly.length,
    depth: maxDepth,
    tree: relativeTree(tree, graph.root),
  }
}

function buildTree(
  file: string,
  importedBy: Map<string, Set<string>>,
  visited: Set<string>,
  depth: number,
): DependencyNode {
  visited.add(file)
  const dependents = importedBy.get(file) || new Set()

  const children: DependencyNode[] = []
  for (const dep of dependents) {
    if (!visited.has(dep)) {
      children.push(buildTree(dep, importedBy, visited, depth + 1))
    }
  }

  return { file, depth, children }
}

function relativeTree(node: DependencyNode, root: string): DependencyNode {
  return {
    file: relative(root, node.file).replace(/\\/g, '/'),
    depth: node.depth,
    children: node.children.map((c) => relativeTree(c, root)),
  }
}

// ─── Refactor Planner ───────────────────────────────────────

/**
 * Generate a safe refactor order for updating dependents of a target file.
 *
 * Strategy: change the target first (source of the change), then update
 * dependents from outermost leaves inward — files that nothing else
 * in the affected set depends on are updated first.
 */
export function planRefactor(
  graph: DependencyGraph,
  targetPath: string,
): RefactorPlan {
  const target = resolve(targetPath)
  const blast = calculateBlastRadius(graph, targetPath)

  const toAbs = (rel: string) => resolve(graph.root, rel)
  const affectedAbs = new Set([
    ...blast.directDependents.map(toAbs),
    ...blast.transitiveDependents.map(toAbs),
  ])
  affectedAbs.add(target)

  // Build sub-graph: count how many affected files depend on each file
  // (in-degree in the "importedBy" direction within the affected set)
  const dependedOnCount = new Map<string, number>()
  for (const file of affectedAbs) {
    dependedOnCount.set(file, 0)
  }

  for (const file of affectedAbs) {
    const importers = graph.importedBy.get(file) || new Set()
    for (const importer of importers) {
      if (affectedAbs.has(importer) && importer !== file) {
        // `file` is depended on by `importer` — increment file's count
        dependedOnCount.set(file, (dependedOnCount.get(file) || 0) + 1)
      }
    }
  }

  // Kahn's algorithm: start with leaf dependents (nobody else in the set depends on them)
  const queue: string[] = []
  for (const [file, count] of dependedOnCount) {
    if (count === 0 && file !== target) {
      queue.push(file)
    }
  }

  const sorted: string[] = []
  const processed = new Set<string>()
  let qHead = 0

  while (qHead < queue.length) {
    const file = queue[qHead++]
    sorted.push(file)
    processed.add(file)

    // This file imports others — decrement their "depended on" count
    const deps = graph.imports.get(file) || new Set()
    for (const dep of deps) {
      if (affectedAbs.has(dep) && !processed.has(dep) && dep !== target) {
        const newCount = (dependedOnCount.get(dep) || 1) - 1
        dependedOnCount.set(dep, newCount)
        if (newCount === 0) {
          queue.push(dep)
        }
      }
    }
  }

  // Add any remaining files (cycles) that weren't reached
  for (const file of affectedAbs) {
    if (!processed.has(file) && file !== target) {
      sorted.push(file)
    }
  }

  // Target first, then leaves → inward
  const ordered = [target, ...sorted]
  const rel = (f: string) => relative(graph.root, f).replace(/\\/g, '/')

  const steps: RefactorStep[] = ordered.map((file) => {
    const fileImports = graph.imports.get(file) || new Set()
    const dependsOn = [...fileImports]
      .filter((dep) => affectedAbs.has(dep))
      .map(rel)

    const relFile = rel(file)
    const depth = file === target ? 0 : (blast.depthMap.get(relFile) || 1)

    return { file: relFile, depth, dependsOn }
  })

  return {
    target: rel(target),
    order: steps,
    totalFiles: steps.length,
  }
}

// ─── Formatting ─────────────────────────────────────────────

export function formatBlastRadius(blast: BlastRadius): string {
  const lines: string[] = []

  lines.push('=== Blast Radius Analysis ===')
  lines.push(`Alvo: ${blast.target}`)
  lines.push(`Arquivos afetados: ${blast.totalAffected}`)
  lines.push(`Profundidade maxima: ${blast.depth}`)
  lines.push('')

  if (blast.directDependents.length > 0) {
    lines.push(`--- Dependentes diretos (${blast.directDependents.length}) ---`)
    for (const dep of blast.directDependents) {
      lines.push(`  ${dep}`)
    }
    lines.push('')
  }

  if (blast.transitiveDependents.length > 0) {
    lines.push(`--- Dependentes transitivos (${blast.transitiveDependents.length}) ---`)
    for (const dep of blast.transitiveDependents) {
      const depth = blast.depthMap.get(dep) || 0
      lines.push(`  ${dep} (depth ${depth})`)
    }
    lines.push('')
  }

  if (blast.totalAffected === 0) {
    lines.push('Nenhum arquivo depende deste modulo. Blast radius = 0.')
    lines.push('')
  }

  lines.push('--- Arvore de impacto ---')
  formatTree(blast.tree, lines, '', true)

  return lines.join('\n')
}

function formatTree(
  node: DependencyNode,
  lines: string[],
  prefix: string,
  isLast: boolean,
): void {
  const connector = isLast ? '\u2514\u2500 ' : '\u251C\u2500 '
  const label = node.depth === 0 ? `[ALVO] ${node.file}` : node.file
  lines.push(`${prefix}${connector}${label}`)

  const childPrefix = prefix + (isLast ? '   ' : '\u2502  ')
  for (let i = 0; i < node.children.length; i++) {
    formatTree(node.children[i], lines, childPrefix, i === node.children.length - 1)
  }
}

export function formatRefactorPlan(plan: RefactorPlan): string {
  const lines: string[] = []

  lines.push('=== Plano de Refatoracao ===')
  lines.push(`Alvo: ${plan.target}`)
  lines.push(`Total de arquivos: ${plan.totalFiles}`)
  lines.push('')
  lines.push('Ordem segura de atualizacao:')
  lines.push('')

  for (let i = 0; i < plan.order.length; i++) {
    const step = plan.order[i]
    const num = `${i + 1}`.padStart(3)
    const depthLabel = step.depth === 0
      ? '[ALVO]'
      : `[depth ${step.depth}]`

    lines.push(`  ${num}. ${step.file} ${depthLabel}`)

    if (step.dependsOn.length > 0) {
      lines.push(`       depende de: ${step.dependsOn.join(', ')}`)
    }
  }

  lines.push('')
  lines.push('Estrategia: Altere o alvo primeiro, depois atualize')
  lines.push('os dependentes de fora para dentro (folhas primeiro).')

  return lines.join('\n')
}
