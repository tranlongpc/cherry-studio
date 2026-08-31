import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { IpcRouter } from '@main/ipc/IpcRouter'
import { IpcError, IpcErrorCode, type IpcResult } from '@shared/ipc/errors/IpcError'
import { quickAssistantRequestSchemas } from '@shared/ipc/schemas/quickAssistant'
import { remoteClientRequestSchemas } from '@shared/ipc/schemas/remoteClient'
import type { IpcHandlersFor } from '@shared/ipc/types'
import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, ipcMain, session, shell, type Tray } from 'electron'

import { RemoteClientQuickAssistant } from './RemoteClientQuickAssistant'
import { RemoteClientSessionService } from './RemoteClientSessionService'
import { createRemoteClientTray } from './remoteClientTray'
import { showRemoteClientWindow } from './remoteClientWindow'

const desktopClientRequestSchemas = {
  ...remoteClientRequestSchemas,
  ...quickAssistantRequestSchemas
}

type DesktopClientRequestSchemas = typeof desktopClientRequestSchemas

let mainWindow: BrowserWindow | null = null
let remoteClientSessionService: RemoteClientSessionService | null = null
let quickAssistant: RemoteClientQuickAssistant | null = null
let tray: Tray | null = null
let isQuitting = false

function registerIpcApi(service: RemoteClientSessionService, assistant: RemoteClientQuickAssistant): void {
  const handlers: IpcHandlersFor<DesktopClientRequestSchemas> = {
    'remote_client.connect': (input) => service.connect(input),
    'remote_client.restore_session': async () => service.restore(),
    'remote_client.clear_session': async () => {
      assistant.clearSessionState()
      await service.clear()
    },
    'quick_assistant.hide': async () => assistant.hide(),
    'quick_assistant.close': async () => assistant.hide(),
    'quick_assistant.set_pin': async ({ isPinned }) => assistant.setPinned(isPinned)
  }
  const router = new IpcRouter(desktopClientRequestSchemas, handlers)
  ipcMain.handle(
    IpcChannel.IpcApi_Request,
    async (event, route: string, input: unknown): Promise<IpcResult<unknown>> => {
      const isMainWindow = event.sender.id === mainWindow?.webContents.id
      const isQuickAssistant = event.sender.id === assistant.getWebContentsId()
      const senderAllowed = route.startsWith('quick_assistant.')
        ? isQuickAssistant
        : route === 'remote_client.connect'
          ? isMainWindow
          : isMainWindow || isQuickAssistant
      if (!senderAllowed) {
        return {
          ok: false,
          error: new IpcError(IpcErrorCode.FORBIDDEN_SENDER, `Rejected IpcApi request: ${route}`).toJSON()
        }
      }
      try {
        const data = await router.dispatch(route, input, { senderId: String(event.sender.id) })
        return { ok: true, data }
      } catch (error) {
        return { ok: false, error: IpcError.from(error).toJSON() }
      }
    }
  )
}

function openExternalUrl(url: string): void {
  const protocol = new URL(url).protocol
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url)
}

async function createWindow(clientSession: Electron.Session): Promise<void> {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/windows/remoteClient/index.html`
    : pathToFileURL(join(__dirname, '../renderer/windows/remoteClient/index.html')).toString()
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/remoteClient.js'),
      session: clientSession
    }
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    mainWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === rendererUrl) return
    event.preventDefault()
    openExternalUrl(url)
  })
  await window.loadURL(rendererUrl)
}

void app.whenReady().then(async () => {
  const authSession = session.fromPartition('persist:remote-client-auth')
  const rendererSession = session.fromPartition('remote-client')
  remoteClientSessionService = new RemoteClientSessionService(authSession, rendererSession)
  const showWindow = () => void showRemoteClientWindow(mainWindow, () => createWindow(rendererSession))
  const quickAssistantRendererUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/windows/remoteClient/quickAssistant/index.html`
    : pathToFileURL(join(__dirname, '../renderer/windows/remoteClient/quickAssistant/index.html')).toString()
  quickAssistant = new RemoteClientQuickAssistant({
    clientSession: rendererSession,
    ensureSession: async () => Boolean(await remoteClientSessionService?.restore()),
    getMainWindow: () => mainWindow,
    isQuitting: () => isQuitting,
    openExternalUrl,
    preloadPath: join(__dirname, '../preload/remoteClient.js'),
    rendererUrl: quickAssistantRendererUrl,
    showMainWindow: showWindow
  })
  registerIpcApi(remoteClientSessionService, quickAssistant)
  tray = createRemoteClientTray({
    showQuickAssistant: () => void quickAssistant?.show(),
    showWindow
  })
  await createWindow(rendererSession)
  app.on('activate', () => {
    showWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  quickAssistant?.destroy()
  quickAssistant = null
  tray?.destroy()
  tray = null
})

app.on('window-all-closed', () => undefined)
