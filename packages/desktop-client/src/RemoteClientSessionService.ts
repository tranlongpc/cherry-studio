import {
  REMOTE_CLIENT_COOKIE,
  REMOTE_CLIENT_HEADER,
  type RemoteClientConnectionInput,
  type RemoteClientConnectionResult,
  type RemoteClientSessionInput
} from '@shared/types/remoteClient'

const REMOTE_CLIENT_ORIGIN_COOKIE = 'cherry_remote_origin'
const REMOTE_CLIENT_ORIGIN_URL = 'https://remote-client.local/'
const REMOTE_CLIENT_SESSION_SECONDS = 30 * 24 * 60 * 60

export class RemoteClientSessionService {
  private remoteOrigin: string | undefined
  private remoteToken: string | undefined

  constructor(
    private readonly authSession: Electron.Session,
    rendererSession: Electron.Session
  ) {
    for (const targetSession of new Set([this.authSession, rendererSession])) {
      targetSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        if (details.method === 'OPTIONS') {
          callback({ requestHeaders: details.requestHeaders })
          return
        }
        const url = new URL(details.url)
        const requestHeaders = { ...details.requestHeaders }
        if (this.remoteOrigin && this.remoteToken && url.origin === this.remoteOrigin) {
          requestHeaders.Authorization = `Bearer ${this.remoteToken}`
          if (url.pathname.startsWith('/web/api')) {
            const cookieHeader = Object.keys(requestHeaders).find((name) => name.toLowerCase() === 'cookie') ?? 'Cookie'
            requestHeaders[cookieHeader] = this.sessionCookieHeader(requestHeaders[cookieHeader], this.remoteToken)
          }
        }
        callback({ requestHeaders })
      })
    }
  }

  async connect(input: RemoteClientConnectionInput): Promise<RemoteClientConnectionResult> {
    let serverUrl: string
    try {
      serverUrl = this.normalizeServerUrl(input.serverUrl)
    } catch {
      return { success: false, error: 'invalid-url' }
    }

    this.remoteOrigin = undefined
    this.remoteToken = undefined
    const signal = AbortSignal.timeout(10_000)
    try {
      const health = await this.authSession.fetch(new URL('/health', serverUrl).toString(), { signal })
      if (!health.ok) return { success: false, error: 'server' }

      const response = await this.authSession.fetch(new URL('/web/api/session', serverUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [REMOTE_CLIENT_HEADER]: 'desktop' },
        body: JSON.stringify({ email: input.email.trim(), password: input.password }),
        credentials: 'include',
        signal
      })
      if (response.status === 401) return { success: false, error: 'authentication' }
      if (!response.ok) return { success: false, error: 'server' }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return { success: false, error: 'server' }
      }
      const cookies = await this.authSession.cookies.get({
        url: new URL('/web/api', serverUrl).toString(),
        name: REMOTE_CLIENT_COOKIE
      })
      const token = this.tokenFromPayload(payload) ?? cookies[0]?.value
      if (!token) return { success: false, error: 'server' }

      const remoteClientSession: RemoteClientSessionInput = { serverUrl, token }
      await this.persist(remoteClientSession)
      this.activate(remoteClientSession)
      return { success: true, session: remoteClientSession }
    } catch {
      return { success: false, error: 'network' }
    }
  }

  async restore(): Promise<RemoteClientSessionInput | null> {
    if (this.remoteOrigin && this.remoteToken) {
      return { serverUrl: this.remoteOrigin, token: this.remoteToken }
    }

    const serverUrl = await this.readPersistedOrigin()
    if (!serverUrl) return null
    const cookies = await this.authSession.cookies.get({
      url: new URL('/web/api', serverUrl).toString(),
      name: REMOTE_CLIENT_COOKIE
    })
    const token = cookies[0]?.value
    if (!token) {
      await this.removePersisted(serverUrl)
      return null
    }

    const restoredSession = { serverUrl, token }
    this.activate(restoredSession)
    try {
      const response = await this.authSession.fetch(new URL('/web/api/session', serverUrl).toString(), {
        credentials: 'include',
        headers: { [REMOTE_CLIENT_HEADER]: 'desktop' },
        signal: AbortSignal.timeout(10_000)
      })
      if (response.status === 401) {
        await this.clear()
        return null
      }
      if (!response.ok) {
        this.deactivate()
        return null
      }
      await this.persist(restoredSession)
      return restoredSession
    } catch {
      this.deactivate()
      return null
    }
  }

  async clear(): Promise<void> {
    const serverUrl = this.remoteOrigin ?? (await this.readPersistedOrigin())
    this.deactivate()
    await this.removePersisted(serverUrl)
  }

  private activate(remoteClientSession: RemoteClientSessionInput): void {
    this.remoteOrigin = remoteClientSession.serverUrl
    this.remoteToken = remoteClientSession.token
  }

  private deactivate(): void {
    this.remoteOrigin = undefined
    this.remoteToken = undefined
  }

  private async persist(remoteClientSession: RemoteClientSessionInput): Promise<void> {
    const expirationDate = Date.now() / 1000 + REMOTE_CLIENT_SESSION_SECONDS
    await Promise.all([
      this.authSession.cookies.set({
        url: new URL('/web/api', remoteClientSession.serverUrl).toString(),
        name: REMOTE_CLIENT_COOKIE,
        value: remoteClientSession.token,
        path: '/web/api',
        httpOnly: true,
        secure: remoteClientSession.serverUrl.startsWith('https://'),
        sameSite: 'lax',
        expirationDate
      }),
      this.authSession.cookies.set({
        url: REMOTE_CLIENT_ORIGIN_URL,
        name: REMOTE_CLIENT_ORIGIN_COOKIE,
        value: encodeURIComponent(remoteClientSession.serverUrl),
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        expirationDate
      })
    ])
    await this.authSession.cookies.flushStore()
  }

  private async readPersistedOrigin(): Promise<string | undefined> {
    const cookies = await this.authSession.cookies.get({
      url: REMOTE_CLIENT_ORIGIN_URL,
      name: REMOTE_CLIENT_ORIGIN_COOKIE
    })
    const value = cookies[0]?.value
    if (!value) return undefined
    try {
      return this.normalizeServerUrl(decodeURIComponent(value))
    } catch {
      await this.authSession.cookies.remove(REMOTE_CLIENT_ORIGIN_URL, REMOTE_CLIENT_ORIGIN_COOKIE)
      await this.authSession.cookies.flushStore()
      return undefined
    }
  }

  private async removePersisted(serverUrl?: string): Promise<void> {
    const removals = [this.authSession.cookies.remove(REMOTE_CLIENT_ORIGIN_URL, REMOTE_CLIENT_ORIGIN_COOKIE)]
    if (serverUrl) {
      removals.push(this.authSession.cookies.remove(new URL('/web/api', serverUrl).toString(), REMOTE_CLIENT_COOKIE))
    }
    await Promise.all(removals)
    await this.authSession.cookies.flushStore()
  }

  private normalizeServerUrl(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid server URL')
    if (url.username || url.password) throw new Error('Invalid server URL')
    return url.origin
  }

  private tokenFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || !('token' in payload)) return undefined
    const token = payload.token
    return typeof token === 'string' && token.trim() ? token.trim() : undefined
  }

  private sessionCookieHeader(value: string | string[] | undefined, token: string): string {
    const cookies = (Array.isArray(value) ? value.join('; ') : (value ?? ''))
      .split(';')
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie && !cookie.startsWith(`${REMOTE_CLIENT_COOKIE}=`))
    cookies.push(`${REMOTE_CLIENT_COOKIE}=${token}`)
    return cookies.join('; ')
  }
}
