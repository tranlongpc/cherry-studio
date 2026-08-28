import { ipcApi } from '@renderer/ipc'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { authenticateWebToken, clearWebToken, installWebBridge } from '../webBridge'

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
    clearWebToken()
    vi.restoreAllMocks()
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
    await authenticateWebToken('cs-sk-valid')
  }

  it('resolves browser-native capabilities without calling the server', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch')
    await expect(window.api.ipcApi.request('system.get_native_theme', undefined)).resolves.toBe('dark')
    await expect(window.api.ipcApi.request('system.get_device_type', undefined)).resolves.toBe('web')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('stores a validated key only in session storage', async () => {
    await authenticate()
    expect(sessionStorage.getItem('cherry-web-token')).toBe('cs-sk-valid')
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

    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/web/api/events'))).toHaveLength(1)
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
})
