/**
 * Command tool implementation: run_command
 */
import { getShell } from '../platform'
import { requireString } from './security'
import { truncate } from './helpers'

export async function toolRunCommand(input: Record<string, unknown>): Promise<string> {
  const cmdErr = requireString(input, 'command')
  if (cmdErr) return cmdErr
  const cmd = input.command as string
  const timeoutSec = Math.min(120, Math.max(5, (input.timeout as number) || 30))

  const shell = getShell()
  const proc = Bun.spawn([...shell, cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  })

  const timer = setTimeout(() => proc.kill(), timeoutSec * 1000)
  // Drain both pipes concurrently to avoid deadlock (HIGH-1 fix)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)

  let result = ''
  if (stdout.trim()) result += stdout.trim()
  if (stderr.trim()) {
    result += (result ? '\n' : '') + 'STDERR:\n' + stderr.trim()
  }
  if (exitCode !== 0) {
    result += (result ? '\n' : '') + `Exit code: ${exitCode}`
  }

  return truncate(result || '(no output)')
}
