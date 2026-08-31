interface RemoteClientRuntimeConfig {
  serverUrl: string
  token: string
}

export const REMOTE_CLIENT_SESSION_EXPIRED_EVENT = 'remote-client-session-expired'

export class RemoteClientRuntimeService {
  private runtimeConfig: RemoteClientRuntimeConfig | undefined
  private remoteBaseElement: HTMLBaseElement | undefined

  normalizeServerUrl(value: string): string {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('INVALID_SERVER_URL')
    if (url.username || url.password) throw new Error('INVALID_SERVER_URL')
    return url.origin
  }

  configure(config: RemoteClientRuntimeConfig): void {
    this.runtimeConfig = {
      serverUrl: this.normalizeServerUrl(config.serverUrl),
      token: config.token
    }
    this.remoteBaseElement ??= document.head.appendChild(document.createElement('base'))
    this.remoteBaseElement.href = this.runtimeConfig.serverUrl
  }

  clear(): void {
    this.runtimeConfig = undefined
    this.remoteBaseElement?.remove()
    this.remoteBaseElement = undefined
  }

  resolveUrl(path: string): string {
    if (!this.runtimeConfig || !path.startsWith('/')) return path
    return new URL(path, this.runtimeConfig.serverUrl).toString()
  }

  getAuthorization(url?: string): string | undefined {
    if (!this.runtimeConfig) return undefined
    if (url && new URL(url, this.runtimeConfig.serverUrl).origin !== this.runtimeConfig.serverUrl) return undefined
    return `Bearer ${this.runtimeConfig.token}`
  }
}

export const remoteClientRuntimeService = new RemoteClientRuntimeService()
