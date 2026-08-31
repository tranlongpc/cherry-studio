import { beforeEach, describe, expect, it } from 'vitest'

import { RemoteClientRuntimeService, remoteClientRuntimeService } from '../RemoteClientRuntimeService'

describe('remoteClientRuntime', () => {
  beforeEach(() => remoteClientRuntimeService.clear())

  it('normalizes an HTTP server origin without retaining credentials or paths', () => {
    const service = new RemoteClientRuntimeService()
    expect(service.normalizeServerUrl(' https://studio.example.com:8443/web ')).toBe('https://studio.example.com:8443')
    expect(() => service.normalizeServerUrl('file:///tmp/server')).toThrow('INVALID_SERVER_URL')
    expect(() => service.normalizeServerUrl('https://user:secret@studio.example.com')).toThrow('INVALID_SERVER_URL')
  })

  it('resolves API resources against the active server and keeps the token in memory', () => {
    const service = new RemoteClientRuntimeService()
    service.configure({ serverUrl: 'https://studio.example.com', token: 'session-token' })

    expect(service.resolveUrl('/web/api/data')).toBe('https://studio.example.com/web/api/data')
    expect(service.resolveUrl('https://cdn.example.com/image.png')).toBe('https://cdn.example.com/image.png')
    expect(service.getAuthorization()).toBe('Bearer session-token')
    expect(service.getAuthorization('https://studio.example.com/web/api/data')).toBe('Bearer session-token')
    expect(service.getAuthorization('https://cdn.example.com/image.png')).toBeUndefined()
    expect(service.getAuthorization('data:image/png;base64,AA==')).toBeUndefined()

    service.clear()

    expect(service.resolveUrl('/web/api/data')).toBe('/web/api/data')
    expect(service.getAuthorization()).toBeUndefined()
  })
})
