/**
 * Git helper functions.
 * SECURITY: All git commands use Bun.spawn with args array (no shell interpolation).
 */

async function exec(...args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { stdout: stdout.trim(), stderr: stderr.trim(), ok: code === 0 }
}

export async function gitDiff(): Promise<string> {
  const staged = await exec('git', 'diff', '--cached')
  const unstaged = await exec('git', 'diff')
  const untracked = await exec('git', 'ls-files', '--others', '--exclude-standard')

  const parts: string[] = []
  if (staged.stdout) parts.push('=== STAGED ===\n' + staged.stdout)
  if (unstaged.stdout) parts.push('=== UNSTAGED ===\n' + unstaged.stdout)
  if (untracked.stdout) parts.push('=== UNTRACKED ===\n' + untracked.stdout)

  return parts.join('\n\n') || '(no changes)'
}

export async function gitStatus(): Promise<string> {
  const result = await exec('git', 'status', '--short')
  return result.ok ? (result.stdout || '(clean)') : result.stderr
}

export async function gitStageAll(): Promise<boolean> {
  const result = await exec('git', 'add', '-A')
  return result.ok
}

export async function gitCommit(message: string): Promise<{ ok: boolean; output: string }> {
  // SAFE: message passed as separate arg, never interpolated into shell string
  const result = await exec('git', 'commit', '-m', message)
  return { ok: result.ok, output: result.stdout || result.stderr }
}

export async function gitPush(): Promise<{ ok: boolean; output: string }> {
  const result = await exec('git', 'push')
  return { ok: result.ok, output: result.stdout || result.stderr }
}

export async function gitLog(n: number = 5): Promise<string> {
  const result = await exec('git', 'log', '--oneline', `-${n}`)
  return result.ok ? result.stdout : result.stderr
}

export async function isGitRepo(): Promise<boolean> {
  const result = await exec('git', 'rev-parse', '--is-inside-work-tree')
  return result.ok && result.stdout === 'true'
}
