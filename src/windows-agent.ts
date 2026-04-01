/**
 * Windows Agent — deep OS integration layer.
 *
 * Provides PowerShell script execution with safety guards,
 * clipboard OCR, and UI awareness (foreground windows).
 *
 * Security model:
 *   - Blocked patterns: Defender disabling, System32 writes, registry tampering
 *   - All scripts run via windows-executor with -NoProfile -NonInteractive -ExecutionPolicy Bypass
 *   - Temp .ps1 files are cleaned up after execution
 *   - ANSI escape sequences stripped from all output
 *   - The tool is classified as 'dangerous' in tool-safety, requiring
 *     explicit user approval when toolApproval != 'auto'
 *
 * REFACTORED: All PowerShell execution now goes through windows-executor.ts
 */

import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { IS_WINDOWS } from './platform'
import { eventBus } from './core/event-bus'
import type { ContextChangedEvent } from './types'
import {
  executePowerShell,
  executePowerShellSTA,
  executePowerShellScript as executeScriptFile,
  DEFAULT_TIMEOUT_MS,
  type ExecutionResult,
} from './utils/windows-executor'

// ─── Constants ──────────────────────────────────────────────

const PS_TIMEOUT_MS = 30_000
const MAX_SCRIPT_LENGTH = 50_000
const MAX_OUTPUT_LENGTH = 100_000

// ─── Context Tracking State ──────────────────────────────────

let _currentContext: { dir: string; foregroundWindow?: string } | null = null

// ─── Safety Guards ──────────────────────────────────────────

/** Patterns that are ALWAYS blocked — no bypass possible */
const BLOCKED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /Set-MpPreference\s.*-Disable/i, reason: 'Tentativa de desativar Windows Defender' },
  { pattern: /Disable-WindowsOptionalFeature.*Defender/i, reason: 'Tentativa de desativar Windows Defender' },
  { pattern: /Stop-Service\s.*WinDefend/i, reason: 'Tentativa de parar Windows Defender' },
  { pattern: /sc\s+(stop|delete|disable)\s+WinDefend/i, reason: 'Tentativa de desabilitar Windows Defender via sc' },
  { pattern: /New-ItemProperty.*DisableAntiSpyware/i, reason: 'Tentativa de desativar proteção via registro' },
  { pattern: /Remove-Item\s.*\\Windows\\System32/i, reason: 'Tentativa de deletar arquivos do System32' },
  { pattern: /Remove-Item\s.*\\Windows\\SysWOW64/i, reason: 'Tentativa de deletar arquivos do SysWOW64' },
  { pattern: /Format-Volume/i, reason: 'Tentativa de formatar volume' },
  { pattern: /Clear-Disk/i, reason: 'Tentativa de limpar disco' },
  { pattern: /Stop-Computer/i, reason: 'Tentativa de desligar computador' },
  { pattern: /Restart-Computer/i, reason: 'Tentativa de reiniciar computador' },
  { pattern: /Set-ExecutionPolicy\s+Unrestricted/i, reason: 'Tentativa de mudar politica de execução permanentemente' },
  { pattern: /\bnet\s+user\s+.*\/add/i, reason: 'Tentativa de criar usuario' },
  { pattern: /\bnet\s+localgroup\s+administrators/i, reason: 'Tentativa de modificar grupo Administrators' },
  { pattern: /Invoke-Expression.*DownloadString/i, reason: 'Tentativa de execução remota (IEX + download)' },
  { pattern: /\biex\s*\(\s*\(?\s*New-Object/i, reason: 'Tentativa de execução remota (IEX + WebClient)' },
]

/** Patterns that require explicit confirmation (flagged as 'dangerous') */
const RISKY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\\Windows\\System32/i, reason: 'Acesso a System32' },
  { pattern: /\\Windows\\SysWOW64/i, reason: 'Acesso a SysWOW64' },
  { pattern: /HKLM:|HKCU:/i, reason: 'Acesso ao registro do Windows' },
  { pattern: /New-Service|Set-Service|Remove-Service/i, reason: 'Manipulação de serviços' },
  { pattern: /New-NetFirewallRule|Remove-NetFirewallRule/i, reason: 'Alteração de regras de firewall' },
  { pattern: /Start-Process\s.*-Verb\s+RunAs/i, reason: 'Elevação de privilegios (RunAs)' },
  { pattern: /Set-ItemProperty\s.*\\CurrentVersion\\Run/i, reason: 'Modificação de programas de inicialização' },
]

export interface ScriptSafetyResult {
  safe: boolean
  blocked: boolean
  reason?: string
}

/**
 * Analyze a PowerShell script for safety.
 * Returns whether it's safe, and if blocked, the reason.
 */
export function analyzeScriptSafety(script: string): ScriptSafetyResult {
  // Check hard blocks first
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(script)) {
      return { safe: false, blocked: true, reason }
    }
  }

  // Check risky patterns (not blocked, but flagged)
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(script)) {
      return { safe: false, blocked: false, reason }
    }
  }

  return { safe: true, blocked: false }
}

// ─── PowerShell Script Execution ────────────────────────────

export interface ScriptResult {
  stdout: string
  stderr: string
  exitCode: number
  duration: number
}

/**
 * Execute a PowerShell script string with safety guards.
 *
 * Creates a temp .ps1 file, runs it with -ExecutionPolicy Bypass
 * (scoped to this process only), and cleans up after.
 */
export async function executePowerShellScript(script: string): Promise<ScriptResult> {
  // Input validation and safety guards run on all platforms
  if (!script.trim()) {
    return { stdout: '', stderr: 'Error: script is empty.', exitCode: 1, duration: 0 }
  }

  if (script.length > MAX_SCRIPT_LENGTH) {
    return { stdout: '', stderr: `Error: script too long (${script.length} chars, max ${MAX_SCRIPT_LENGTH}).`, exitCode: 1, duration: 0 }
  }

  // Safety check
  const safety = analyzeScriptSafety(script)
  if (safety.blocked) {
    return { stdout: '', stderr: `BLOCKED: ${safety.reason}`, exitCode: 1, duration: 0 }
  }

  if (!IS_WINDOWS) {
    return { stdout: '', stderr: 'Error: PowerShell scripts only available on Windows.', exitCode: 1, duration: 0 }
  }

  // Write temp .ps1 file
  const scriptId = randomUUID().slice(0, 8)
  const scriptPath = join(tmpdir(), `smolerclaw-${scriptId}.ps1`)

  try {
    writeFileSync(scriptPath, script, 'utf-8')

    const result = await executeScriptFile(scriptPath, { timeout: PS_TIMEOUT_MS })

    return {
      stdout: result.stdout,
      stderr: result.timedOut ? 'Script timeout exceeded' : result.stderr,
      exitCode: result.exitCode,
      duration: result.duration,
    }
  } finally {
    // Always clean up the temp script
    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath)
    } catch { /* best effort cleanup */ }
  }
}

// ─── Clipboard Reading ──────────────────────────────────────

export type ClipboardContentType = 'text' | 'image' | 'empty' | 'error'

export interface ClipboardContent {
  type: ClipboardContentType
  text: string
}

/**
 * Read clipboard content. Detects text or image (with OCR).
 * Uses Windows PowerShell via System.Windows.Forms and Windows.Media.Ocr.
 */
export async function readClipboardContent(): Promise<ClipboardContent> {
  if (!IS_WINDOWS) {
    return { type: 'error', text: 'Clipboard reading only available on Windows.' }
  }

  // First try to get text
  const textResult = await readClipboardText()
  if (textResult.type === 'text') return textResult

  // If no text, try image OCR
  const ocrResult = await readClipboardImageOCR()
  return ocrResult
}

async function readClipboardText(): Promise<ClipboardContent> {
  const cmd = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$clip = [System.Windows.Forms.Clipboard]::GetText()',
    'if ($clip) { $clip } else { "___EMPTY___" }',
  ].join('; ')

  try {
    const result = await executePowerShellSTA(cmd, { timeout: 10_000 })

    if (result.timedOut) {
      return { type: 'error', text: 'Clipboard read timeout.' }
    }

    const text = result.stdout.trim()
    if (text === '___EMPTY___' || !text) {
      return { type: 'empty', text: '' }
    }
    return { type: 'text', text }
  } catch {
    return { type: 'error', text: 'Failed to read clipboard text.' }
  }
}

async function readClipboardImageOCR(): Promise<ClipboardContent> {
  // PowerShell script that:
  // 1. Checks if clipboard has an image
  // 2. Saves it to a temp file
  // 3. Uses Windows.Media.Ocr to extract text
  // 4. Returns the text and cleans up
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if (-not $img) {
  Write-Output "___NO_IMAGE___"
  exit
}
$tmpFile = [System.IO.Path]::Combine($env:TEMP, "smolerclaw-ocr-$(Get-Random).png")
try {
  $img.Save($tmpFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

  $asyncOp = [Windows.Storage.StorageFile]::GetFileFromPathAsync($tmpFile)
  $taskFile = [System.WindowsRuntimeSystemExtensions]::AsTask($asyncOp)
  $taskFile.Wait()
  $storageFile = $taskFile.Result

  $asyncStream = $storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)
  $taskStream = [System.WindowsRuntimeSystemExtensions]::AsTask($asyncStream)
  $taskStream.Wait()
  $stream = $taskStream.Result

  $asyncDecoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
  $taskDecoder = [System.WindowsRuntimeSystemExtensions]::AsTask($asyncDecoder)
  $taskDecoder.Wait()
  $decoder = $taskDecoder.Result

  $asyncBitmap = $decoder.GetSoftwareBitmapAsync()
  $taskBitmap = [System.WindowsRuntimeSystemExtensions]::AsTask($asyncBitmap)
  $taskBitmap.Wait()
  $bitmap = $taskBitmap.Result

  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  $asyncResult = $ocrEngine.RecognizeAsync($bitmap)
  $taskResult = [System.WindowsRuntimeSystemExtensions]::AsTask($asyncResult)
  $taskResult.Wait()
  $result = $taskResult.Result

  if ($result.Text) {
    Write-Output $result.Text
  } else {
    Write-Output "___NO_TEXT___"
  }
} catch {
  Write-Output "___OCR_ERROR___: $($_.Exception.Message)"
} finally {
  if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
}
`

  try {
    const result = await executePowerShellSTA(script, { timeout: 20_000 })

    if (result.timedOut) {
      return { type: 'error', text: 'OCR timeout.' }
    }

    const text = result.stdout.trim()

    if (text === '___NO_IMAGE___') {
      return { type: 'empty', text: '' }
    }
    if (text === '___NO_TEXT___') {
      return { type: 'image', text: '(Imagem detectada no clipboard, mas sem texto reconhecivel)' }
    }
    if (text.startsWith('___OCR_ERROR___')) {
      return { type: 'error', text: `OCR falhou: ${text.replace('___OCR_ERROR___: ', '')}` }
    }
    if (text) {
      return { type: 'image', text: `[OCR do clipboard]\n${text}` }
    }
    return { type: 'empty', text: '' }
  } catch {
    return { type: 'error', text: 'Failed to perform OCR on clipboard image.' }
  }
}

// ─── UI Awareness ───────────────────────────────────────────

export interface WindowInfo {
  pid: number
  name: string
  title: string
  memoryMB: number
}

/**
 * Get detailed info about visible windows, including foreground window.
 * Returns structured data about what the user is looking at.
 */
export async function analyzeScreenContext(): Promise<string> {
  if (!IS_WINDOWS) {
    return 'Error: screen context analysis only available on Windows.'
  }

  const script = `
$sig = @'
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
$User32 = Add-Type -MemberDefinition $sig -Name User32 -Namespace Win32 -PassThru

$fgHwnd = $User32::GetForegroundWindow()
$fgPid = 0
$null = $User32::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)

$fgProc = if ($fgPid -gt 0) { Get-Process -Id $fgPid -ErrorAction SilentlyContinue } else { $null }
$fgName = if ($fgProc) { $fgProc.ProcessName } else { "unknown" }
$fgTitle = if ($fgProc) { $fgProc.MainWindowTitle } else { "" }

Write-Output "=== FOREGROUND ==="
Write-Output "PID: $fgPid"
Write-Output "Process: $fgName"
Write-Output "Title: $fgTitle"
Write-Output ""
Write-Output "=== ALL VISIBLE WINDOWS ==="

Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
  Sort-Object -Property WorkingSet64 -Descending |
  Select-Object -First 20 Id, ProcessName,
    @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}},
    MainWindowTitle |
  ForEach-Object {
    $marker = if ($_.Id -eq $fgPid) { " [ACTIVE]" } else { "" }
    Write-Output "  PID:$($_.Id) | $($_.ProcessName) | $($_.MemMB)MB | $($_.MainWindowTitle)$marker"
  }
`

  try {
    const result = await executePowerShell(script, { timeout: 15_000 })

    if (result.timedOut) {
      return 'Error: screen context analysis timeout'
    }

    const output = result.stdout.trim()
    if (!output && result.stderr.trim()) {
      return `Error: ${result.stderr.trim()}`
    }
    return output || 'Nenhuma janela visivel encontrada.'
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── Context Change Detection ───────────────────────────────

/**
 * Check current context (directory + foreground window) and emit event if changed.
 * Call this periodically or after relevant operations.
 */
export async function checkContextChange(currentDir: string): Promise<void> {
  let foregroundWindow: string | undefined

  // Get foreground window info if on Windows
  if (IS_WINDOWS) {
    try {
      const context = await analyzeScreenContext()
      // Extract foreground window from the output
      const match = context.match(/Process:\s*(\S+)/)
      foregroundWindow = match?.[1]
    } catch {
      // Ignore errors — context detection is best-effort
    }
  }

  const previousDir = _currentContext?.dir
  const previousWindow = _currentContext?.foregroundWindow

  // Check if context actually changed
  const dirChanged = previousDir !== currentDir
  const windowChanged = foregroundWindow && previousWindow !== foregroundWindow

  if (dirChanged || windowChanged) {
    const event: ContextChangedEvent = {
      previousDir,
      currentDir,
      foregroundWindow,
      timestamp: Date.now(),
    }

    // Update tracked context
    _currentContext = { dir: currentDir, foregroundWindow }

    // Emit the event synchronously for UI updates
    eventBus.emit('context:changed', event)
  }
}

/**
 * Initialize context tracking with current directory.
 */
export function initContextTracking(currentDir: string): void {
  _currentContext = { dir: currentDir }
}

/**
 * Get current tracked context.
 */
export function getCurrentContext(): { dir: string; foregroundWindow?: string } | null {
  return _currentContext
}

// ─── Windows Toast Notifications ─────────────────────────────

export interface NotificationResult {
  success: boolean
  error?: string
}

/**
 * Send a Windows toast notification.
 * Uses the Windows Runtime ToastNotificationManager API.
 */
export async function sendNotification(
  title: string,
  message: string,
): Promise<NotificationResult> {
  // Input validation runs on all platforms
  if (!title?.trim()) {
    return { success: false, error: 'Title is required.' }
  }

  if (!message?.trim()) {
    return { success: false, error: 'Message is required.' }
  }

  if (!IS_WINDOWS) {
    return { success: false, error: 'Notifications only available on Windows.' }
  }

  // Escape single quotes for PowerShell
  const safeTitle = title.replace(/'/g, "''")
  const safeMessage = message.replace(/'/g, "''")

  const script = `
$notificationTitle = '${safeTitle}'
$notificationText = '${safeMessage}'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$toastXml = [xml]$template.GetXml()
$toastXml.GetElementsByTagName('text').Item(0).AppendChild($toastXml.CreateTextNode($notificationTitle)) > $null
$toastXml.GetElementsByTagName('text').Item(1).AppendChild($toastXml.CreateTextNode($notificationText)) > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($toastXml.OuterXml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Smolerclaw').Show($toast)
Write-Output 'OK'
`

  try {
    const result = await executePowerShellScript(script)

    if (result.exitCode === 0 && result.stdout.includes('OK')) {
      return { success: true }
    }

    return {
      success: false,
      error: result.stderr || 'Unknown error sending notification.',
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
