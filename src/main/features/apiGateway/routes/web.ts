import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

import { application } from '@application'
import { AiStreamAdmissionError, type StreamListener } from '@main/ai/streamManager'
import { translateService } from '@main/services/translate/translateService'
import type { AiStreamOpenRequest } from '@shared/ai/transport'
import type { DataRequest } from '@shared/data/api/types'
import type { CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type { UnifiedPreferenceKeyType, UnifiedPreferenceType } from '@shared/data/preference/preferenceTypes'
import { FileEntryIdSchema } from '@shared/data/types/file'
import type { FileMetadata } from '@shared/data/types/legacyFile'
import { createInternalEntryInputSchema } from '@shared/ipc/schemas/file'
import { FILE_TYPE, type FileType } from '@shared/types/file'
import { audioExts, documentExts, imageExts, textExts, videoExts } from '@shared/utils/file'
import { Elysia } from 'elysia'

import { authenticateWebCredentials, isWebSessionAuthenticated, webAuthConfigured, webSessionCookie } from '../webAuth'
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

const MAX_WEB_UPLOAD_BYTES = 100 * 1024 * 1024

function fileTypeForExtension(ext: string): FileType {
  const dotted = ext ? `.${ext.replace(/^\./, '').toLowerCase()}` : ''
  if (imageExts.includes(dotted)) return FILE_TYPE.IMAGE
  if (videoExts.includes(dotted)) return FILE_TYPE.VIDEO
  if (audioExts.includes(dotted)) return FILE_TYPE.AUDIO
  if (textExts.includes(dotted)) return FILE_TYPE.TEXT
  if (documentExts.includes(dotted)) return FILE_TYPE.DOCUMENT
  return FILE_TYPE.OTHER
}

async function storeWebUpload(filename: string, bytes: Uint8Array): Promise<FileMetadata> {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_WEB_UPLOAD_BYTES) {
    throw new Error(`File size must be between 1 byte and ${MAX_WEB_UPLOAD_BYTES} bytes`)
  }
  const ext = extname(filename).slice(1).toLowerCase()
  const name = ext ? filename.slice(0, -(ext.length + 1)) : filename
  const manager = application.get('FileManager')
  const entry = await manager.createInternalEntry({
    source: 'bytes',
    data: bytes,
    name,
    ext: ext || null,
    cleanupPolicy: 'delete_when_unreferenced'
  })
  const path = manager.getPhysicalPath(entry.id)
  return {
    id: entry.id,
    name: filename,
    origin_name: filename,
    path,
    size: bytes.byteLength,
    ext: ext ? `.${ext}` : '.',
    type: fileTypeForExtension(ext),
    created_at: new Date(entry.createdAt).toISOString(),
    count: 1
  }
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
  'app.get_info',
  'file.get_metadata',
  'knowledge.create_base',
  'system.get_ip_country'
] as const

function isRemoteIpcRoute(route: string): boolean {
  return (REMOTE_IPC_ROUTES as readonly string[]).includes(route)
}

function authorize(request: Request, set: { status?: number | string }) {
  if (isWebSessionAuthenticated(request)) return undefined
  set.status = 401
  return { error: 'Unauthorized' }
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
      headers: {
        'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream'
      }
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

type FileRequest =
  | { action: 'createInternalEntry'; params: unknown }
  | { action: 'getPhysicalPath'; id: string }
  | { action: 'notesCheckName'; dirPath: string; fileName: string; isFile: boolean }
  | { action: 'notesWrite'; filePath: string; content: string }
  | { action: 'notesMkdir'; dirPath: string }
  | { action: 'notesValidateDirectory'; dirPath: string }
  | { action: 'readManaged'; filePath: string; encoding?: boolean }

function managedReadPath(candidate: string): string {
  const target = resolve(candidate)
  const roots = [application.getPath('feature.files.data'), application.getPath('feature.notes.data')].map((path) =>
    resolve(path)
  )
  if (!roots.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
    throw new Error('File path is outside managed storage')
  }
  return target
}

function notesPath(candidate: string): string {
  const root = resolve(application.getPath('feature.notes.data'))
  const target = resolve(candidate)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Notes path is outside managed storage')
  return target
}

function safeNoteName(value: string): string {
  const safe = basename(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid note name')
  return safe.replace(/\.md$/i, '')
}

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
    ({ request, set }) => {
      const failure = authorize(request, set)
      if (failure) {
        return failure.error
      }
      const clientId = request.headers.get('x-cherry-web-client-id')?.trim() ?? ''
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
    ({ body, request, set }) => {
      const failure = authorize(request, set)
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
    async ({ body, request, set }) => {
      if (!webAuthConfigured()) {
        set.status = 503
        return { error: 'Web authentication is not configured' }
      }
      const { email, password } = body as { email?: string; password?: string }
      if (!email || !password) {
        set.status = 400
        return { error: 'Email and password are required' }
      }
      const token = await authenticateWebCredentials(email, password)
      if (!token) {
        set.status = 401
        return { error: 'Invalid email or password' }
      }
      set.headers['set-cookie'] = webSessionCookie(token, new URL(request.url).protocol === 'https:')
      return { authenticated: true }
    },
    { detail: { hide: true } }
  )
  .get(
    '/web/api/session',
    ({ request, set }) => {
      const failure = authorize(request, set)
      return failure ?? { authenticated: true }
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/data',
    async ({ body, request, set }) => {
      const failure = authorize(request, set)
      if (failure) return failure
      return application
        .get('DataApiService')
        .getApiServer()
        .handleRequest(body as DataRequest)
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/files',
    async ({ body, headers, request, set }) => {
      const failure = authorize(request, set)
      if (failure) return failure
      const encodedName = headers['x-file-name']
      if (!encodedName) {
        set.status = 400
        return { error: 'Missing file name' }
      }
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body as Uint8Array)
      return storeWebUpload(decodeURIComponent(encodedName), bytes)
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/file',
    async ({ body, request: httpRequest, set }) => {
      const failure = authorize(httpRequest, set)
      if (failure) return failure
      const request = body as FileRequest
      const manager = application.get('FileManager')
      if (request.action === 'createInternalEntry') {
        return manager.createInternalEntry(createInternalEntryInputSchema.parse(request.params))
      }
      if (request.action === 'getPhysicalPath') {
        return { data: manager.getPhysicalPath(FileEntryIdSchema.parse(request.id)) }
      }
      if (request.action === 'notesCheckName') {
        const dir = notesPath(request.dirPath)
        const safeName = safeNoteName(request.fileName)
        const target = join(dir, request.isFile ? `${safeName}.md` : safeName)
        const exists = await stat(target)
          .then(() => true)
          .catch(() => false)
        return { safeName, exists }
      }
      if (request.action === 'notesWrite') {
        const target = notesPath(request.filePath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, request.content, 'utf8')
        return { success: true }
      }
      if (request.action === 'notesMkdir') {
        await mkdir(notesPath(request.dirPath), { recursive: true })
        return { success: true }
      }
      if (request.action === 'notesValidateDirectory') {
        try {
          return (await stat(notesPath(request.dirPath))).isDirectory()
        } catch {
          return false
        }
      }
      if (request.action === 'readManaged') {
        const content = await readFile(managedReadPath(request.filePath))
        return request.encoding ? { data: content.toString('utf8') } : { data: Array.from(content) }
      }
      set.status = 400
      return { error: 'Unknown file action' }
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/ipc',
    async ({ body, request: httpRequest, set }) => {
      const failure = authorize(httpRequest, set)
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
    async ({ body, request, set }) => {
      const failure = authorize(request, set)
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
    '/web/api/translate/open',
    ({ body, request: httpRequest, set }) => {
      const failure = authorize(httpRequest, set)
      if (failure) return failure
      const request = body as { clientId: string; streamId: string; text: string; targetLangCode: string }
      const listener = webEventClients.get(request.clientId)?.listeners.get(request.streamId)
      if (!listener) {
        set.status = 409
        return { error: 'Translation stream is not subscribed' }
      }
      return translateService.openWithListener(listener, request as never)
    },
    { detail: { hide: true } }
  )
  .post(
    '/web/api/preference',
    async ({ body, request: httpRequest, set }) => {
      const failure = authorize(httpRequest, set)
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
