import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, screen } from 'electron'

interface RemoteClientQuickAssistantOptions {
  clientSession: Electron.Session
  ensureSession: () => Promise<boolean>
  getMainWindow: () => BrowserWindow | null
  isQuitting: () => boolean
  openExternalUrl: (url: string) => void
  preloadPath: string
  rendererUrl: string
  showMainWindow: () => void
}

export class RemoteClientQuickAssistant {
  private createPromise: Promise<BrowserWindow> | null = null
  private isPinned = false
  private wasMainWindowFocused = false
  private window: BrowserWindow | null = null

  constructor(private readonly options: RemoteClientQuickAssistantOptions) {}

  async show(): Promise<void> {
    if (!(await this.options.ensureSession())) {
      this.options.showMainWindow()
      return
    }

    const window = await this.getOrCreateWindow()
    this.wasMainWindowFocused = this.options.getMainWindow()?.isFocused() ?? false
    if (window.isMinimized()) {
      window.setOpacity(0)
      window.show()
    }
    this.repositionToCursorDisplay(window)
    window.setAlwaysOnTop(true, 'floating')
    window.setOpacity(1)
    window.show()
    window.focus()
    window.webContents.send(IpcChannel.IpcApi_Event, 'quick_assistant.shown', undefined)
  }

  hide(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (process.platform === 'win32') {
      window.setOpacity(0)
      window.minimize()
      return
    }
    window.hide()
    if (process.platform === 'darwin' && !this.wasMainWindowFocused) {
      const majorVersion = Number.parseInt(process.getSystemVersion().split('.')[0], 10)
      if (majorVersion < 26) app.hide()
    }
  }

  setPinned(isPinned: boolean): void {
    this.isPinned = isPinned
  }

  clearSessionState(): void {
    this.isPinned = false
    this.hide()
  }

  getWebContentsId(): number | undefined {
    return this.window && !this.window.isDestroyed() ? this.window.webContents.id : undefined
  }

  destroy(): void {
    this.window?.destroy()
    this.window = null
  }

  private async getOrCreateWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window
    if (this.createPromise) return this.createPromise
    this.createPromise = this.createWindow().finally(() => {
      this.createPromise = null
    })
    return this.createPromise
  }

  private async createWindow(): Promise<BrowserWindow> {
    const platformOptions =
      process.platform === 'darwin'
        ? ({
            type: 'panel',
            transparent: true,
            vibrancy: 'under-window',
            visualEffectState: 'followWindow'
          } as const)
        : {}
    const window = new BrowserWindow({
      width: 550,
      height: 400,
      minWidth: 350,
      minHeight: 380,
      maxWidth: 1024,
      maxHeight: 768,
      frame: false,
      alwaysOnTop: true,
      useContentSize: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      ...platformOptions,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.options.preloadPath,
        session: this.options.clientSession
      }
    })
    this.window = window
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.on('blur', () => {
      if (!this.isPinned) this.hide()
    })
    window.on('close', (event) => {
      if (this.options.isQuitting()) return
      event.preventDefault()
      this.hide()
    })
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.options.openExternalUrl(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (url === this.options.rendererUrl) return
      event.preventDefault()
      this.options.openExternalUrl(url)
    })
    await window.loadURL(this.options.rendererUrl)
    return window
  }

  private repositionToCursorDisplay(window: BrowserWindow): void {
    const bounds = window.getBounds()
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const windowDisplay = screen.getDisplayNearestPoint(bounds)
    if (cursorDisplay.id === windowDisplay.id) return
    const { width, height } = bounds
    const x = Math.round(cursorDisplay.workArea.x + (cursorDisplay.workArea.width - width) / 2)
    const y = Math.round(cursorDisplay.workArea.y + (cursorDisplay.workArea.height - height) / 2)
    window.setBounds({ x, y, width, height })
  }
}
