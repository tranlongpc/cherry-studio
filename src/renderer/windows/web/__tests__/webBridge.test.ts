import { ipcApi } from '@renderer/ipc'
import { AbsoluteFilePathSchema } from '@shared/types/file'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { authenticateWebCredentials, clearWebSession, installWebBridge } from '../webBridge'

function eventStreamResponse(): { response: Response; send: (message: unknown) => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'ready' })}\n`))
    }
  })
  return {
    response: new Response(body, { status: 200 }),
    send: (message) => controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`))
  }
}

describe('webBridge', () => {
  beforeEach(() => {
    clearWebSession()
    vi.restoreAllMocks()
    document.documentElement.style.removeProperty('zoom')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true }))
    })
    installWebBridge()
  })

  async function authenticate(): Promise<void> {
    vi.spyOn(window, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ authenticated: true }), { status: 200 })
    )
    await authenticateWebCredentials('user@example.com', 'secret-password')
  }

  it('resolves browser-native capabilities without calling the server', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch')
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const setStyleSpy = vi.spyOn(document.documentElement.style, 'setProperty')
    const removeStyleSpy = vi.spyOn(document.documentElement.style, 'removeProperty')

    await expect(ipcApi.request('system.get_native_theme')).resolves.toBe('dark')
    await expect(ipcApi.request('system.get_device_type')).resolves.toBe('web')
    await expect(ipcApi.request('system.get_fonts')).resolves.toEqual([])
    await expect(ipcApi.request('system.shell.open_website', 'https://example.com')).resolves.toBeUndefined()
    await expect(ipcApi.request('app.adjust_zoom', { delta: 0 })).resolves.toBe(1)
    await expect(ipcApi.request('app.adjust_zoom', { delta: 0.1 })).resolves.toBe(1.1)

    expect(setStyleSpy).toHaveBeenCalledWith('zoom', '1.1')

    await expect(ipcApi.request('app.adjust_zoom', { delta: 0, reset: true })).resolves.toBe(1)

    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(removeStyleSpy).toHaveBeenCalledWith('zoom')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('handles main-window navigation lifecycle locally in the browser', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch')

    await expect(ipcApi.request('navigation.protocol_dispatch_ready')).resolves.toBeUndefined()
    await expect(ipcApi.request('navigation.ack_open_route', { requestId: 1 })).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves native window and protocol bootstrap state locally', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch')

    await expect(ipcApi.request('window.get_init_data')).resolves.toBeNull()
    await expect(ipcApi.request('window.is_maximized')).resolves.toBe(false)
    await expect(ipcApi.request('mcp.protocol_install.list_pending')).resolves.toEqual([])

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns synchronous cleanup functions for desktop-only event listeners', () => {
    const cleanup: unknown = window.api.shortcut.onRegistrationConflict(vi.fn())
    if (cleanup instanceof Promise) void cleanup.catch(() => {})

    expect(cleanup).toBeTypeOf('function')
    expect((cleanup as () => void)()).toBeUndefined()
  })

  it('sends credentials in the request body without storing them in browser storage', async () => {
    await authenticate()
    const request = vi.mocked(window.fetch).mock.calls[0]
    expect(request[0]).toBe('/web/api/session')
    expect(request[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.com', password: 'secret-password' })
    })
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.getItem('cherry-web-token')).toBeNull()
  })

  it('uses one event stream, ref-counts subscriptions, and delivers multiple turns', async () => {
    await authenticate()
    const events = eventStreamResponse()
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(events.response)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'attached', bufferedChunks: [] }), { status: 200 }))

    const chunks: string[] = []
    window.api.ipcApi.on('ai.stream.chunk', (payload: any) => chunks.push(payload.chunk.delta))
    await ipcApi.request('ai.stream.attach', { topicId: 'topic-1' })
    await ipcApi.request('ai.stream.attach', { topicId: 'topic-1' })

    events.send({
      type: 'event',
      data: {
        event: 'ai.stream.chunk',
        payload: {
          topicId: 'topic-1',
          executionId: 'provider::model',
          attemptId: 1,
          chunk: { type: 'text-delta', id: 'text-1', delta: 'first' }
        }
      }
    })
    events.send({
      type: 'event',
      data: { event: 'ai.stream.done', payload: { topicId: 'topic-1', status: 'success', isTopicDone: true } }
    })
    events.send({
      type: 'event',
      data: {
        event: 'ai.stream.chunk',
        payload: {
          topicId: 'topic-1',
          executionId: 'provider::model',
          attemptId: 2,
          chunk: { type: 'text-delta', id: 'text-2', delta: 'second' }
        }
      }
    })
    await vi.waitFor(() => expect(chunks).toEqual(['first', 'second']))

    const eventRequests = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/web/api/events'))
    expect(eventRequests).toHaveLength(1)
    expect(eventRequests[0]).toEqual([
      '/web/api/events',
      expect.objectContaining({ headers: { 'x-cherry-web-client-id': expect.any(String) } })
    ])
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/web/api/stream/subscription'))).toHaveLength(1)
  })

  it('subscribes before finite open acknowledgement so composer send can complete', async () => {
    await authenticate()
    const events = eventStreamResponse()
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(events.response)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mode: 'started', activeExecutions: [], reservedMessages: [] }), { status: 200 })
      )

    await expect(
      ipcApi.request('ai.stream.open', {
        trigger: 'submit-message',
        topicId: 'topic-open',
        mentionedModelIds: [],
        userMessageParts: [{ type: 'text', text: 'hello' }]
      })
    ).resolves.toEqual({ mode: 'started', activeExecutions: [], reservedMessages: [] })

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/web/api/events'),
      '/web/api/stream/open'
    ])
  })

  it('connects the event stream before creating a remote directory tree', async () => {
    await authenticate()
    const events = eventStreamResponse()
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(events.response)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              treeId: 'tree-1',
              revision: 0,
              snapshot: { kind: 'directory', path: '/managed/Agents', basename: 'Agents', children: {} }
            }
          }),
          { status: 200 }
        )
      )

    await ipcApi.request('file.tree.create', { rootPath: AbsoluteFilePathSchema.parse('/managed/Agents') })

    const eventClientId = (fetchSpy.mock.calls[0][1]!.headers as Record<string, string>)['x-cherry-web-client-id']
    expect(fetchSpy.mock.calls[1][0]).toBe('/web/api/ipc')
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
      route: 'file.tree.create',
      input: { rootPath: '/managed/Agents' },
      clientId: eventClientId
    })
  })

  it('opens a browser picker and uploads the selected file', async () => {
    await authenticate()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', {
        configurable: true,
        value: [new File(['hello'], 'notes.txt', { type: 'text/plain' })]
      })
      this.dispatchEvent(new Event('change'))
    })
    vi.spyOn(window, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'file-1',
          name: 'notes.txt',
          origin_name: 'notes.txt',
          path: '/mock/notes.txt',
          size: 5,
          ext: '.txt',
          type: 'text',
          created_at: '2026-01-01T00:00:00.000Z',
          count: 1
        }),
        { status: 200 }
      )
    )

    await expect(
      window.api.file.select({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Files', extensions: ['txt'] }]
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'notes.txt', path: '/mock/notes.txt' })])
    expect(click).toHaveBeenCalledOnce()
  })

  it('bridges the send-time file entry and physical path operations', async () => {
    await authenticate()
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '01912345-6789-7abc-8def-0123456789ab' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: '/mock/Data/Files/copied.txt' }), { status: 200 }))

    const entry = await window.api.file.createInternalEntry({
      source: 'path',
      path: '/mock/Data/Files/upload.txt' as never,
      cleanupPolicy: 'delete_when_unreferenced'
    })
    const path = await window.api.file.getPhysicalPath({ id: entry.id as never })

    expect(path).toBe('/mock/Data/Files/copied.txt')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('subscribes a translation stream before opening it on main', async () => {
    await authenticate()
    const events = eventStreamResponse()
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(events.response)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'attached', bufferedChunks: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ streamId: 'translate:1' }), { status: 200 }))

    await expect(
      ipcApi.request('translate.open', { streamId: 'translate:1', text: 'hello', targetLangCode: 'vi-VN' })
    ).resolves.toEqual({ streamId: 'translate:1' })

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/web/api/events'),
      '/web/api/stream/subscription',
      '/web/api/translate/open'
    ])
  })

  it('bridges the constrained Notes operations used by Save to Notes', async () => {
    await authenticate()
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ safeName: 'Saved note', exists: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))

    await expect(window.api.file.checkFileName('/mock/feature.notes.data', 'Saved note', true)).resolves.toEqual({
      safeName: 'Saved note',
      exists: false
    })
    await expect(window.api.file.write('/mock/feature.notes.data/Saved note.md', '# Saved')).resolves.toEqual({
      success: true
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('downloads saved text files in the browser without calling the server', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn() })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(window, 'fetch')

    await expect(window.api.file.save('message.md', '# Hello')).resolves.toBe('message.md')
    await Promise.resolve()

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reads only managed files through the web file endpoint', async () => {
    await authenticate()
    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: '# Note' }), { status: 200 }))

    await expect(window.api.file.readExternal('/mock/feature.notes.data/note.md')).resolves.toBe('# Note')
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('returns controlled fallbacks for desktop-only file dialogs', async () => {
    await expect(window.api.file.selectFolder()).resolves.toBeNull()
    await expect(window.api.file.open()).resolves.toBeNull()
    await expect(window.api.file.openPath('/tmp/file')).resolves.toBeUndefined()
  })
})
