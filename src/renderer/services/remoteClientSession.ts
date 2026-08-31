import { IpcError, IpcErrorCode, type IpcResult } from '@shared/ipc/errors/IpcError'
import type { RemoteClientInputFor, RemoteClientOutputFor, RemoteClientRoute } from '@shared/ipc/schemas/remoteClient'
import type { RemoteClientConnectionErrorKind, RemoteClientConnectionInput } from '@shared/types/remoteClient'

import { remoteClientRuntimeService } from './RemoteClientRuntimeService'

export type { RemoteClientConnectionErrorKind } from '@shared/types/remoteClient'

export class RemoteClientConnectionError extends Error {
  constructor(readonly kind: RemoteClientConnectionErrorKind) {
    super(kind)
  }
}

async function requestRemoteClient<R extends RemoteClientRoute>(
  route: R,
  ...args: RemoteClientInputFor<R> extends void ? [] : [input: RemoteClientInputFor<R>]
): Promise<RemoteClientOutputFor<R>> {
  if (!window.remoteClient) throw new IpcError(IpcErrorCode.INTERNAL, 'Remote client IPC is unavailable')
  const result = await window.remoteClient.request(route, args[0])
  if (typeof result !== 'object' || result === null || !('ok' in result)) {
    throw new IpcError(IpcErrorCode.INTERNAL, 'IpcApi returned a malformed result')
  }
  const envelope = result as IpcResult<RemoteClientOutputFor<R>>
  if (envelope.ok) return envelope.data
  throw IpcError.fromJSON(envelope.error)
}

export async function connectRemoteClient(credentials: RemoteClientConnectionInput): Promise<void> {
  let serverUrl: string
  try {
    serverUrl = remoteClientRuntimeService.normalizeServerUrl(credentials.serverUrl)
  } catch {
    throw new RemoteClientConnectionError('invalid-url')
  }

  try {
    const result = await requestRemoteClient('remote_client.connect', {
      serverUrl,
      email: credentials.email.trim(),
      password: credentials.password
    })
    if (!result.success) throw new RemoteClientConnectionError(result.error)

    remoteClientRuntimeService.configure(result.session)
  } catch (error) {
    remoteClientRuntimeService.clear()
    if (window.remoteClient) await requestRemoteClient('remote_client.clear_session').catch(() => undefined)
    if (error instanceof RemoteClientConnectionError) throw error
    throw new RemoteClientConnectionError('network')
  }
}

export async function restoreRemoteClient(): Promise<boolean> {
  remoteClientRuntimeService.clear()
  if (!window.remoteClient) return false
  try {
    const session = await requestRemoteClient('remote_client.restore_session')
    if (!session) return false
    remoteClientRuntimeService.configure(session)
    return true
  } catch {
    return false
  }
}

export async function disconnectRemoteClient(): Promise<void> {
  remoteClientRuntimeService.clear()
  if (window.remoteClient) await requestRemoteClient('remote_client.clear_session')
}
