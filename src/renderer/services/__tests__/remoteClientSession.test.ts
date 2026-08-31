import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { remoteClientRuntimeService } from '../RemoteClientRuntimeService'
import type { RemoteClientConnectionError } from '../remoteClientSession'
import { connectRemoteClient, restoreRemoteClient } from '../remoteClientSession'

describe('remoteClientSession', () => {
  const request = vi.fn()

  beforeEach(() => {
    remoteClientRuntimeService.clear()
    request.mockReset().mockImplementation((route: string) => {
      if (route === 'remote_client.clear_session') return Promise.resolve({ ok: true, data: undefined })
      return Promise.resolve({
        ok: true,
        data: {
          success: true,
          session: { serverUrl: 'https://studio.example.com', token: 'session-token' }
        }
      })
    })
    Object.defineProperty(window, 'remoteClient', {
      configurable: true,
      value: { request }
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('authenticates through Electron and activates the remote API runtime', async () => {
    await connectRemoteClient({
      serverUrl: 'https://studio.example.com/web',
      email: ' user@example.com ',
      password: 'secret-password'
    })

    expect(request).toHaveBeenCalledWith('remote_client.connect', {
      serverUrl: 'https://studio.example.com',
      email: 'user@example.com',
      password: 'secret-password'
    })
    expect(remoteClientRuntimeService.resolveUrl('/web/api/data')).toBe('https://studio.example.com/web/api/data')
    expect(remoteClientRuntimeService.getAuthorization()).toBe('Bearer session-token')
  })

  it('restores the Electron session without credentials', async () => {
    request.mockResolvedValue({
      ok: true,
      data: { serverUrl: 'https://studio.example.com', token: 'persisted-token' }
    })

    await expect(restoreRemoteClient()).resolves.toBe(true)

    expect(request).toHaveBeenCalledWith('remote_client.restore_session', undefined)
    expect(remoteClientRuntimeService.resolveUrl('/web/api/data')).toBe('https://studio.example.com/web/api/data')
    expect(remoteClientRuntimeService.getAuthorization()).toBe('Bearer persisted-token')
  })

  it('keeps the runtime inactive when no persisted session exists', async () => {
    request.mockResolvedValue({ ok: true, data: null })

    await expect(restoreRemoteClient()).resolves.toBe(false)

    expect(remoteClientRuntimeService.resolveUrl('/web/api/data')).toBe('/web/api/data')
  })

  it('rejects invalid URLs before making a network request', async () => {
    await expect(
      connectRemoteClient({ serverUrl: 'file:///tmp/server', email: 'user@example.com', password: 'secret-password' })
    ).rejects.toMatchObject({ kind: 'invalid-url' } satisfies Partial<RemoteClientConnectionError>)
    expect(request).not.toHaveBeenCalled()
  })

  it('distinguishes rejected credentials from connection failures', async () => {
    request.mockResolvedValue({ ok: true, data: { success: false, error: 'authentication' } })

    await expect(
      connectRemoteClient({
        serverUrl: 'https://studio.example.com',
        email: 'user@example.com',
        password: 'wrong-password'
      })
    ).rejects.toMatchObject({ kind: 'authentication' } satisfies Partial<RemoteClientConnectionError>)
  })

  it('reports unreachable hosts as network failures', async () => {
    request.mockRejectedValue(new Error('IPC unavailable'))

    await expect(
      connectRemoteClient({
        serverUrl: 'https://offline.example.com',
        email: 'user@example.com',
        password: 'secret-password'
      })
    ).rejects.toMatchObject({ kind: 'network' } satisfies Partial<RemoteClientConnectionError>)
  })

  it('removes the remote runtime when Electron rejects the session', async () => {
    request.mockRejectedValue(new Error('IPC unavailable'))

    await expect(
      connectRemoteClient({
        serverUrl: 'https://studio.example.com',
        email: 'user@example.com',
        password: 'secret-password'
      })
    ).rejects.toMatchObject({ kind: 'network' } satisfies Partial<RemoteClientConnectionError>)
    expect(remoteClientRuntimeService.resolveUrl('/web/api/data')).toBe('/web/api/data')
    expect(remoteClientRuntimeService.getAuthorization()).toBeUndefined()
    expect(request).toHaveBeenCalledWith('remote_client.clear_session', undefined)
  })
})
