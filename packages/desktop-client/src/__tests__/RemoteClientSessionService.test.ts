import { REMOTE_CLIENT_HEADER } from '@shared/types/remoteClient'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteClientSessionService } from '../RemoteClientSessionService'

type BeforeSendHeadersListener = (
  details: Electron.OnBeforeSendHeadersListenerDetails,
  callback: (response: Electron.BeforeSendResponse) => void
) => void

describe('RemoteClientSessionService', () => {
  const fetchRequest = vi.fn()
  const getCookies = vi.fn()
  const setCookie = vi.fn()
  const removeCookie = vi.fn()
  const flushStore = vi.fn()
  let authBeforeSendHeaders: BeforeSendHeadersListener
  let rendererBeforeSendHeaders: BeforeSendHeadersListener
  let service: RemoteClientSessionService

  beforeEach(() => {
    fetchRequest.mockReset()
    getCookies.mockReset().mockResolvedValue([])
    setCookie.mockReset().mockResolvedValue(undefined)
    removeCookie.mockReset().mockResolvedValue(undefined)
    flushStore.mockReset().mockResolvedValue(undefined)
    const authSession = {
      fetch: fetchRequest,
      cookies: { flushStore, get: getCookies, remove: removeCookie, set: setCookie },
      webRequest: {
        onBeforeSendHeaders: vi.fn((_filter, listener: BeforeSendHeadersListener) => {
          authBeforeSendHeaders = listener
        })
      }
    } as unknown as Electron.Session
    const rendererSession = {
      webRequest: {
        onBeforeSendHeaders: vi.fn((_filter, listener: BeforeSendHeadersListener) => {
          rendererBeforeSendHeaders = listener
        })
      }
    } as unknown as Electron.Session
    service = new RemoteClientSessionService(authSession, rendererSession)
  })

  it('uses the cookie session returned by an existing web server', async () => {
    fetchRequest
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true }), { status: 200 }))
    getCookies.mockResolvedValue([{ value: 'legacy-session-token' }])

    const result = await service.connect({
      serverUrl: 'https://studio.example.com/web',
      email: ' user@example.com ',
      password: 'secret-password'
    })

    expect(result).toEqual({
      success: true,
      session: { serverUrl: 'https://studio.example.com', token: 'legacy-session-token' }
    })
    expect(fetchRequest).toHaveBeenNthCalledWith(
      2,
      'https://studio.example.com/web/api/session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ email: 'user@example.com', password: 'secret-password' })
      })
    )
    expect(new Headers(fetchRequest.mock.calls[1][1].headers).get(REMOTE_CLIENT_HEADER)).toBe('desktop')

    const rendererCallback = vi.fn()
    rendererBeforeSendHeaders(
      {
        id: 1,
        url: 'https://studio.example.com/web/api/data',
        method: 'POST',
        resourceType: 'xhr',
        referrer: '',
        timestamp: 1,
        requestHeaders: {}
      },
      rendererCallback
    )
    expect(rendererCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: 'Bearer legacy-session-token',
        Cookie: 'cherry_web_session=legacy-session-token'
      }
    })
  })

  it('uses the token returned by an updated server without requiring a cookie', async () => {
    fetchRequest
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, token: 'response-token' }), { status: 200 })
      )

    await expect(
      service.connect({
        serverUrl: 'https://studio.example.com',
        email: 'user@example.com',
        password: 'secret-password'
      })
    ).resolves.toEqual({
      success: true,
      session: { serverUrl: 'https://studio.example.com', token: 'response-token' }
    })
    expect(setCookie).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://studio.example.com/web/api',
        name: 'cherry_web_session',
        value: 'response-token',
        path: '/web/api'
      })
    )
    expect(setCookie).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://remote-client.local/',
        name: 'cherry_remote_origin',
        value: encodeURIComponent('https://studio.example.com')
      })
    )
    expect(flushStore).toHaveBeenCalledOnce()
  })

  it('restores and validates a persisted remote session without credentials', async () => {
    getCookies.mockImplementation(({ name }: Electron.CookiesGetFilter) => {
      if (name === 'cherry_remote_origin') {
        return Promise.resolve([{ value: encodeURIComponent('https://studio.example.com') }])
      }
      if (name === 'cherry_web_session') return Promise.resolve([{ value: 'persisted-token' }])
      return Promise.resolve([])
    })
    fetchRequest.mockResolvedValue(new Response(JSON.stringify({ authenticated: true }), { status: 200 }))

    await expect(service.restore()).resolves.toEqual({
      serverUrl: 'https://studio.example.com',
      token: 'persisted-token'
    })
    expect(fetchRequest).toHaveBeenCalledWith(
      'https://studio.example.com/web/api/session',
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('clears an expired persisted session', async () => {
    getCookies.mockImplementation(({ name }: Electron.CookiesGetFilter) => {
      if (name === 'cherry_remote_origin') {
        return Promise.resolve([{ value: encodeURIComponent('https://studio.example.com') }])
      }
      if (name === 'cherry_web_session') return Promise.resolve([{ value: 'expired-token' }])
      return Promise.resolve([])
    })
    fetchRequest.mockResolvedValue(new Response(undefined, { status: 401 }))

    await expect(service.restore()).resolves.toBeNull()
    expect(removeCookie).toHaveBeenCalledWith('https://studio.example.com/web/api', 'cherry_web_session')
    expect(removeCookie).toHaveBeenCalledWith('https://remote-client.local/', 'cherry_remote_origin')
  })

  it('keeps persisted authentication when validation is temporarily unavailable', async () => {
    getCookies.mockImplementation(({ name }: Electron.CookiesGetFilter) => {
      if (name === 'cherry_remote_origin') {
        return Promise.resolve([{ value: encodeURIComponent('https://studio.example.com') }])
      }
      if (name === 'cherry_web_session') return Promise.resolve([{ value: 'persisted-token' }])
      return Promise.resolve([])
    })
    fetchRequest.mockRejectedValue(new Error('offline'))

    await expect(service.restore()).resolves.toBeNull()
    expect(removeCookie).not.toHaveBeenCalled()
  })

  it('adds authentication only to the configured server origin', async () => {
    fetchRequest
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, token: 'response-token' }), { status: 200 })
      )
    await service.connect({
      serverUrl: 'https://studio.example.com',
      email: 'user@example.com',
      password: 'secret-password'
    })

    const remoteCallback = vi.fn()
    rendererBeforeSendHeaders(
      {
        id: 1,
        url: 'https://studio.example.com/web/api/data',
        method: 'POST',
        resourceType: 'xhr',
        referrer: '',
        timestamp: 1,
        requestHeaders: {}
      },
      remoteCallback
    )
    expect(remoteCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: 'Bearer response-token',
        Cookie: 'cherry_web_session=response-token'
      }
    })

    const externalCallback = vi.fn()
    rendererBeforeSendHeaders(
      {
        id: 2,
        url: 'https://cdn.example.com/image.png',
        method: 'GET',
        resourceType: 'image',
        referrer: '',
        timestamp: 1,
        requestHeaders: {}
      },
      externalCallback
    )
    expect(externalCallback).toHaveBeenCalledWith({ requestHeaders: {} })

    const authCallback = vi.fn()
    authBeforeSendHeaders(
      {
        id: 3,
        url: 'https://studio.example.com/web/api/session',
        method: 'GET',
        resourceType: 'xhr',
        referrer: '',
        timestamp: 1,
        requestHeaders: {}
      },
      authCallback
    )
    expect(authCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: 'Bearer response-token',
        Cookie: 'cherry_web_session=response-token'
      }
    })

    const preflightCallback = vi.fn()
    rendererBeforeSendHeaders(
      {
        id: 4,
        url: 'https://studio.example.com/web/api/data',
        method: 'OPTIONS',
        resourceType: 'xhr',
        referrer: '',
        timestamp: 1,
        requestHeaders: { Origin: 'file://' }
      },
      preflightCallback
    )
    expect(preflightCallback).toHaveBeenCalledWith({ requestHeaders: { Origin: 'file://' } })
  })

  it('keeps rejected credentials distinct from network failures', async () => {
    fetchRequest
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401 }))

    await expect(
      service.connect({
        serverUrl: 'https://studio.example.com',
        email: 'user@example.com',
        password: 'wrong-password'
      })
    ).resolves.toEqual({ success: false, error: 'authentication' })
  })

  it('removes the active cookie when the client disconnects', async () => {
    fetchRequest
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, token: 'response-token' }), { status: 200 })
      )
    await service.connect({
      serverUrl: 'https://studio.example.com',
      email: 'user@example.com',
      password: 'secret-password'
    })

    await service.clear()

    expect(removeCookie).toHaveBeenCalledWith('https://studio.example.com/web/api', 'cherry_web_session')
    expect(removeCookie).toHaveBeenCalledWith('https://remote-client.local/', 'cherry_remote_origin')
    expect(flushStore).toHaveBeenCalled()
  })
})
