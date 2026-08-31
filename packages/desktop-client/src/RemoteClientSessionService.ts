import {
  REMOTE_CLIENT_COOKIE,
  REMOTE_CLIENT_HEADER,
  type RemoteClientConnectionInput,
  type RemoteClientConnectionResult,
  type RemoteClientSessionInput
} from '@shared/types/remoteClient'

export class RemoteClientSessionService {
  private remoteOrigin: string | undefined
  private remoteToken: string | undefined

  constructor(private readonly clientSession: Electron.Session) {
    this.clientSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
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
      const health = await this.clientSession.fetch(new URL('/health', serverUrl).toString(), { signal })
      if (!health.ok) return { success: false, error: 'server' }

      const response = await this.clientSession.fetch(new URL('/web/api/session', serverUrl).toString(), {
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
      const cookies = await this.clientSession.cookies.get({
        url: new URL('/web/api', serverUrl).toString(),
        name: REMOTE_CLIENT_COOKIE
      })
      const token = this.tokenFromPayload(payload) ?? cookies[0]?.value
      if (!token) return { success: false, error: 'server' }

      const remoteClientSession: RemoteClientSessionInput = { serverUrl, token }
      this.remoteOrigin = remoteClientSession.serverUrl
      this.remoteToken = remoteClientSession.token
      return { success: true, session: remoteClientSession }
    } catch {
      return { success: false, error: 'network' }
    }
  }

  async clear(): Promise<void> {
    const serverUrl = this.remoteOrigin
    this.remoteOrigin = undefined
    this.remoteToken = undefined
    if (!serverUrl) return
    await this.clientSession.cookies.remove(new URL('/web/api', serverUrl).toString(), REMOTE_CLIENT_COOKIE)
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
