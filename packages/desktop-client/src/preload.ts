import { IpcChannel } from '@shared/IpcChannel'
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('remoteClient', {
  request: (route: string, input?: unknown) => ipcRenderer.invoke(IpcChannel.IpcApi_Request, route, input)
})
