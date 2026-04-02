/**
 * Electrobun Desktop Application
 * Native desktop wrapper for smolerclaw
 */

import { createWebServer } from '../web/server'
import type { Message, ChatEvent } from '../../types'
import type { SessionManager } from '../../session'
import { t } from '../../i18n'

/**
 * Generic provider interface matching both ClaudeProvider and OpenAICompatProvider
 */
interface ChatProvider {
  chat(messages: Message[], systemPrompt: string, enableTools?: boolean): AsyncGenerator<ChatEvent>
  setApprovalCallback?(cb: (name: string, input: Record<string, unknown>, riskLevel: string) => Promise<boolean>): void
}

interface DesktopAppConfig {
  provider: ChatProvider
  systemPrompt: string
  enableTools: boolean
  sessionManager: SessionManager
  devMode?: boolean
}

// Check if Electrobun is available
const hasElectrobun = typeof globalThis !== 'undefined' && 'Electrobun' in globalThis

/**
 * Creates and launches the desktop application
 * Falls back to opening in default browser if Electrobun is not available
 */
export async function launchDesktopApp(config: DesktopAppConfig) {
  const port = await findAvailablePort(3847)

  // Start the web server
  const server = createWebServer({
    port,
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    enableTools: config.enableTools,
    sessionManager: config.sessionManager,
  })

  server.start()

  const url = `http://localhost:${port}`

  if (hasElectrobun) {
    // Use Electrobun native window
    await launchElectrobunWindow(url, config.devMode)
  } else {
    // Fall back to system browser or provide instructions
    console.log(`\n  ${t('desktop.not_available')}`)
    console.log(`  ${t('desktop.opening_browser', { url })}\n`)
    await openInBrowser(url)
  }

  return { port, url }
}

async function launchElectrobunWindow(url: string, devMode = false) {
  // Dynamic import for Electrobun
  const Electrobun = (globalThis as Record<string, unknown>).Electrobun as ElectrobunAPI

  const window = await Electrobun.createBrowserWindow({
    title: 'smolerclaw',
    url,
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: true,
    titleBarStyle: 'hidden',
    vibrancy: 'under-window',
    backgroundColor: '#0d1117',
    webPreferences: {
      devTools: devMode,
    },
  })

  // Handle window events
  window.on('closed', () => {
    process.exit(0)
  })

  // Setup IPC handlers
  setupIPC(Electrobun)

  return window
}

function setupIPC(Electrobun: ElectrobunAPI) {
  // Handle native menu actions
  Electrobun.ipc.on('menu:new-chat', () => {
    Electrobun.ipc.send('app:new-chat')
  })

  Electrobun.ipc.on('menu:settings', () => {
    Electrobun.ipc.send('app:open-settings')
  })

  Electrobun.ipc.on('menu:toggle-theme', () => {
    Electrobun.ipc.send('app:toggle-theme')
  })

  // Setup native menu with i18n
  Electrobun.setApplicationMenu([
    {
      label: 'smolerclaw',
      submenu: [
        { label: t('desktop.about'), role: 'about' },
        { type: 'separator' },
        { label: t('desktop.settings'), accelerator: 'CmdOrCtrl+,', click: () => Electrobun.ipc.send('menu:settings') },
        { type: 'separator' },
        { label: t('desktop.quit'), accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: t('desktop.chat'),
      submenu: [
        { label: t('desktop.new_chat'), accelerator: 'CmdOrCtrl+N', click: () => Electrobun.ipc.send('menu:new-chat') },
        { type: 'separator' },
        { label: t('desktop.clear_chat'), accelerator: 'CmdOrCtrl+K', click: () => Electrobun.ipc.send('menu:clear-chat') },
      ],
    },
    {
      label: t('desktop.edit'),
      submenu: [
        { label: t('desktop.undo'), accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: t('desktop.redo'), accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: t('desktop.cut'), accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: t('desktop.copy'), accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: t('desktop.paste'), accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: t('desktop.select_all'), accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: t('desktop.view'),
      submenu: [
        { label: t('desktop.toggle_theme'), accelerator: 'CmdOrCtrl+Shift+T', click: () => Electrobun.ipc.send('menu:toggle-theme') },
        { type: 'separator' },
        { label: t('desktop.actual_size'), accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: t('desktop.zoom_in'), accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: t('desktop.zoom_out'), accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: t('desktop.dev_tools'), accelerator: 'Alt+CmdOrCtrl+I', role: 'toggleDevTools' },
      ],
    },
    {
      label: t('desktop.window'),
      submenu: [
        { label: t('desktop.minimize'), accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: t('desktop.zoom'), role: 'zoom' },
        { type: 'separator' },
        { label: t('desktop.close'), accelerator: 'CmdOrCtrl+W', role: 'close' },
      ],
    },
    {
      label: t('desktop.help'),
      submenu: [
        { label: t('desktop.documentation'), click: () => openInBrowser('https://github.com/ktfth/smolerclaw') },
        { label: t('desktop.report_issue'), click: () => openInBrowser('https://github.com/ktfth/smolerclaw/issues') },
      ],
    },
  ])
}

async function openInBrowser(url: string) {
  const { exec } = await import('node:child_process')
  const { platform } = await import('node:os')

  const commands: Record<string, string> = {
    darwin: `open "${url}"`,
    win32: `start "" "${url}"`,
    linux: `xdg-open "${url}"`,
  }

  const cmd = commands[platform()] || commands.linux
  exec(cmd, (err) => {
    if (err) console.error('Failed to open browser:', err)
  })
}

async function findAvailablePort(startPort: number): Promise<number> {
  const net = await import('node:net')

  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1))
    })
    server.listen(startPort, () => {
      server.close(() => {
        resolve(startPort)
      })
    })
  })
}

// Type definitions for Electrobun API
interface ElectrobunAPI {
  createBrowserWindow(options: BrowserWindowOptions): Promise<BrowserWindow>
  setApplicationMenu(menu: MenuItem[]): void
  ipc: {
    on(channel: string, callback: () => void): void
    send(channel: string, data?: unknown): void
  }
}

interface BrowserWindowOptions {
  title: string
  url: string
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  frame?: boolean
  titleBarStyle?: 'default' | 'hidden' | 'hiddenInset'
  vibrancy?: string
  backgroundColor?: string
  webPreferences?: {
    devTools?: boolean
  }
}

interface BrowserWindow {
  on(event: string, callback: () => void): void
  close(): void
  focus(): void
  minimize(): void
  maximize(): void
}

interface MenuItem {
  label?: string
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  role?: string
  accelerator?: string
  submenu?: MenuItem[]
  click?: () => void
}
