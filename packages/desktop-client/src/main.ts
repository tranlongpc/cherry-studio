import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { IpcRouter } from '@main/ipc/IpcRouter'
import { IpcError, IpcErrorCode, type IpcResult } from '@shared/ipc/errors/IpcError'
import { type RemoteClientRequestSchemas, remoteClientRequestSchemas } from '@shared/ipc/schemas/remoteClient'
import type { IpcHandlersFor } from '@shared/ipc/types'
import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, ipcMain, session, shell } from 'electron'

import { RemoteClientSessionService } from './RemoteClientSessionService'

let mainWindow: BrowserWindow | null = null
let remoteClientSessionService: RemoteClientSessionService | null = null

function registerIpcApi(service: RemoteClientSessionService): void {
  const handlers: IpcHandlersFor<RemoteClientRequestSchemas> = {
    'remote_client.connect': (input) => service.connect(input),
    'remote_client.clear_session': async () => service.clear()
  }
  const router = new IpcRouter(remoteClientRequestSchemas, handlers)
  ipcMain.handle(
    IpcChannel.IpcApi_Request,
    async (event, route: string, input: unknown): Promise<IpcResult<unknown>> => {
      if (event.sender.id !== mainWindow?.webContents.id) {
        return {
          ok: false,
          error: new IpcError(IpcErrorCode.FORBIDDEN_SENDER, `Rejected IpcApi request: ${route}`).toJSON()
        }
      }
      try {
        const data = await router.dispatch(route, input, { senderId: null })
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
  window.on('closed', () => {
    mainWindow = null
    void remoteClientSessionService?.clear()
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
  const clientSession = session.fromPartition('remote-client')
  remoteClientSessionService = new RemoteClientSessionService(clientSession)
  registerIpcApi(remoteClientSessionService)
  await createWindow(clientSession)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(clientSession)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
