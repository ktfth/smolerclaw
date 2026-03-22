import { IS_WINDOWS, IS_MAC } from './platform'

/**
 * Copy text to system clipboard. Cross-platform.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const cmd = IS_WINDOWS
      ? ['powershell', '-NoProfile', '-Command', 'Set-Clipboard -Value $input']
      : IS_MAC
        ? ['pbcopy']
        : ['xclip', '-selection', 'clipboard']

    const proc = Bun.spawn(cmd, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    proc.stdin.write(text)
    proc.stdin.end()
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}
