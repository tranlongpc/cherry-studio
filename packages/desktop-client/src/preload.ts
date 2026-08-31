import { IpcChannel } from '@shared/IpcChannel'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('remoteClient', {
  platform: process.platform,
  request: (route: string, input?: unknown) => ipcRenderer.invoke(IpcChannel.IpcApi_Request, route, input),
  on: (event: string, callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, name: string, payload: unknown) => {
      if (name === event) callback(payload)
    }
    ipcRenderer.on(IpcChannel.IpcApi_Event, listener)
    return () => ipcRenderer.removeListener(IpcChannel.IpcApi_Event, listener)
  }
})
