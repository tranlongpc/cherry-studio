import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { application } from '@application'
import { AiStreamAdmissionError, type StreamListener } from '@main/ai/streamManager'
import type { AiStreamOpenRequest } from '@shared/ai/transport'
import type { DataRequest } from '@shared/data/api/types'
import type { CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type { UnifiedPreferenceKeyType, UnifiedPreferenceType } from '@shared/data/preference/preferenceTypes'
import { Elysia } from 'elysia'

import { authorizeApiRequest } from '../middleware/auth'
import { type WebStreamEvent, WebStreamListener } from '../WebStreamListener'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

const REMOTE_IPC_ROUTES = [
  'ai.agent.create',
  'ai.agent.delete',
  'ai.agent.session.close_warm',
  'ai.agent.session.delete',
  'ai.agent.session.refresh_context_usage',
  'ai.agent.session.reuse_or_create',
  'ai.agent.session.stop_background_task',
  'ai.agent.sessions.delete',
  'ai.agent.support_session.create',
  'ai.agent.task.create',
  'ai.agent.task.delete',
  'ai.agent.task.pause',
  'ai.agent.task.resume',
  'ai.agent.task.run',
  'ai.agent.task.update',
  'ai.agent.workspace.delete',
  'ai.provider.model.check',
  'ai.provider.model.list',
  'ai.stream.abort',
  'ai.text.generate',
  'ai.tool.get_result',
  'system.get_ip_country'
] as const

function isRemoteIpcRoute(route: string): boolean {
  return (REMOTE_IPC_ROUTES as readonly string[]).includes(route)
}

function bearerToken(headers: Record<string, string | undefined>): string | undefined {
  const authorization = headers.authorization
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
}

function authorize(headers: Record<string, string | undefined>, set: { status?: number | string }) {
  const failure = authorizeApiRequest(headers['x-api-key'], bearerToken(headers))
  if (!failure) return undefined
  set.status = failure.status
  return { error: failure.error }
}

function rendererRoot(): string {
  return resolve(application.getPath('app.root'), 'out', 'renderer')
}

async function staticResponse(relativePath: string): Promise<Response> {
  const root = rendererRoot()
  const file = resolve(root, relativePath)
  if (file !== root && !file.startsWith(`${root}${sep}`)) return new Response('Not found', { status: 404 })

  try {
    const content = await readFile(file)
    return new Response(content, {
      headers: { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

type PreferenceRequest =
  | { action: 'get'; key: UnifiedPreferenceKeyType }
  | { action: 'set'; key: UnifiedPreferenceKeyType; value: unknown }
  | { action: 'getMultipleRaw'; keys: UnifiedPreferenceKeyType[] }
  | { action: 'setMultiple'; updates: Partial<UnifiedPreferenceType> }
  | { action: 'getAll' }

interface WebEventClient {
  controller: ReadableStreamDefaultController<Uint8Array>
  listeners: Map<string, WebStreamListener>
}

const webEventClients = new Map<string, WebEventClient>()
const encoder = new TextEncoder()

function remoteDispatchListener(topicId: string): StreamListener {
  return {
    id: `web-request:${randomUUID()}:${topicId}`,
    onChunk() {},
    onDone() {},
    onPaused() {},
    onError() {},
    isAlive: () => false
  }
}

function closeEventClient(clientId: string): void {
  const client = webEventClients.get(clientId)
  if (!client) return
  for (const [topicId, listener] of client.listeners) {
    listener.close()
    application.get('AiStreamManager').detachListener(topicId, listener.id)
  }
  webEventClients.delete(clientId)
}

export const webRoutes = new Elysia()
  .get('/web', () => staticResponse('windows/web/index.html'), { detail: { hide: true } })
  .get('/web/', () => staticResponse('windows/web/index.html'), { detail: { hide: true } })
  .get('/assets/*', ({ params }) => staticResponse(`assets/${params['*']}`), { detail: { hide: true } })
  .get(
    '/web/api/events',
    ({ query, request, set }) => {
      const failure = authorizeApiRequest(undefined, typeof query.token === 'string' ? query.token : undefined)
      if (failure) {
        set.status = failure.status
        return failure.error
      }
      const clientId = typeof query.clientId === 'string' ? query.clientId : ''
      if (!clientId) {
        set.status = 400
        return 'Missing clientId'
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          closeEventClient(clientId)
          webEventClients.set(clientId, { controller, listeners: new Map() })
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'ready' })}\n`))
          request.signal.addEventListener('abort', () => closeEventClient(clientId), { once: true })
        },
        cancel() {
          closeEventClient(clientId)
        }
      })
      return new Response(stream, {
        headers: { 'cache-control': 'no-cache, no-transform', 'content-type': 'application/x-ndjson; charset=utf-8' }
      })
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/stream/subscription',
    ({ body, headers, set }) => {
      const failure = authorize(headers, set)
      if (failure) return failure
      const { clientId, topicId, action } = body as {
        clientId: string
        topicId: string
        action: 'subscribe' | 'unsubscribe'
      }
      const client = webEventClients.get(clientId)
      if (!client) {
        set.status = 409
        return { error: 'Event stream is not connected' }
      }

      if (action === 'subscribe') {
        if (!client.listeners.has(topicId)) {
          const send = (payload: unknown) => client.controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
          const listener = new WebStreamListener(
            `web:${clientId}:${topicId}`,
            topicId,
            (event: WebStreamEvent) => send({ type: 'event', data: event }),
            (cache: CacheSyncMessage) => send({ type: 'cache', data: cache })
          )
          client.listeners.set(topicId, listener)
          application.get('AiStreamManager').attachOrWaitListener(listener, { topicId })
        }
        return { status: 'attached', bufferedChunks: [] }
      }

      const listener = client.listeners.get(topicId)
      if (listener) {
        listener.close()
        application.get('AiStreamManager').detachListener(topicId, listener.id)
        client.listeners.delete(topicId)
      }
      return { success: true }
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/session',
    ({ headers, set }) => {
      const failure = authorize(headers, set)
      return failure ?? { authenticated: true }
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/data',
    async ({ body, headers, set }) => {
      const failure = authorize(headers, set)
      if (failure) return failure
      return application
        .get('DataApiService')
        .getApiServer()
        .handleRequest(body as DataRequest)
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/ipc',
    async ({ body, headers, set }) => {
      const failure = authorize(headers, set)
      if (failure) return failure
      const request = body as { route: string; input: unknown }
      if (!isRemoteIpcRoute(request.route)) {
        set.status = 403
        return { error: 'Route is not available to remote clients' }
      }
      return application.get('IpcApiService').requestFromRemote(request.route, request.input)
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/stream/open',
    async ({ body, headers, set }) => {
      const failure = authorize(headers, set)
      if (failure) return failure
      const streamRequest = body as AiStreamOpenRequest
      try {
        return await application
          .get('AiStreamManager')
          .dispatch(remoteDispatchListener(streamRequest.topicId), streamRequest)
      } catch (error) {
        if (error instanceof AiStreamAdmissionError) return { mode: 'blocked', reason: error.reason }
        throw error
      }
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/preference',
    async ({ body, headers, set }) => {
      const failure = authorize(headers, set)
      if (failure) return failure

      const request = body as PreferenceRequest
      const preferences = application.get('PreferenceService')
      switch (request.action) {
        case 'get':
          return { data: preferences.get(request.key) }
        case 'set':
          await preferences.set(request.key, request.value as never)
          return { data: null }
        case 'getMultipleRaw':
          return { data: preferences.getMultipleRaw(request.keys) }
        case 'setMultiple':
          await preferences.setMultiple(request.updates)
          return { data: null }
        case 'getAll':
          return { data: preferences.getAll() }
      }
    },
    { detail: { hide: true } }
  )
