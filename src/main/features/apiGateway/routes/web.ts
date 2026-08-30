import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

import { application } from '@application'
import { agentWorkspaceService } from '@data/services/AgentWorkspaceService'
import { AiStreamAdmissionError, type StreamListener } from '@main/ai/streamManager'
import { translateService } from '@main/services/translate/translateService'
import type { AiStreamOpenRequest } from '@shared/ai/transport'
import type { DataRequest } from '@shared/data/api/types'
import type { CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type { UnifiedPreferenceKeyType, UnifiedPreferenceType } from '@shared/data/preference/preferenceTypes'
import { PRESETS_BINARY_TOOLS } from '@shared/data/presets/binaryTools'
import { CODE_CLI_TOOL_PRESET_BY_EXECUTABLE } from '@shared/data/presets/codeCliTools'
import { FileEntryIdSchema } from '@shared/data/types/file'
import type { FileMetadata } from '@shared/data/types/legacyFile'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { binaryRequestSchemas } from '@shared/ipc/schemas/binary'
import { fileRequestSchemas } from '@shared/ipc/schemas/file'
import { createInternalEntryInputSchema } from '@shared/ipc/schemas/file'
import { knowledgeRequestSchemas } from '@shared/ipc/schemas/knowledge'
import { FILE_TYPE, type FileType } from '@shared/types/file'
import type { TreeMutationPushPayload } from '@shared/utils/file'
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
const REMOTE_BINARY_TOOL_NAMES = new Set([
  ...PRESETS_BINARY_TOOLS.map((tool) => tool.name),
  ...Object.keys(CODE_CLI_TOOL_PRESET_BY_EXECUTABLE)
])

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
  'ai.agent.session.prewarm',
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
  'ai.tool.respond_approval',
  'app.cache_cleanup.inspect',
  'app.get_info',
  'binary.get_latest_versions',
  'binary.get_tool_snapshots',
  'channel.get_statuses',
  'file.batch_get_dangling_states',
  'file.batch_get_metadata',
  'file.batch_get_physical_paths',
  'file.get_metadata',
  'file_processing.list_available_processors',
  'knowledge.create_base',
  'knowledge.get_file_path',
  'knowledge.list_item_chunks',
  'knowledge.search',
  'local_model.get_acceleration_capability',
  'local_model.get_status',
  'mcp.server.get_version',
  'mcp.server.list_prompts',
  'mcp.server.list_resources',
  'mcp.server.read_resource_preview',
  'mcp.server.refresh_tools',
  'mcp.tool.abort_call',
  'ovms.get_status',
  'ovms.is_supported',
  'skill.reconcile',
  'system.get_ip_country'
] as const

function isRemoteIpcRoute(route: string): boolean {
  return (REMOTE_IPC_ROUTES as readonly string[]).includes(route)
}

function isRemoteCodeOwnedBinaryInput(route: 'binary.install_tool' | 'binary.remove_tool', input: unknown): boolean {
  const parsed = binaryRequestSchemas[route].input.safeParse(input)
  return parsed.success && REMOTE_BINARY_TOOL_NAMES.has(parsed.data.name)
}

function isPathWithinRoot(candidate: string, rootPath: string): boolean {
  const target = resolve(candidate)
  const root = resolve(rootPath)
  return target === root || target.startsWith(`${root}${sep}`)
}

async function isExistingPathWithinRoot(candidate: string, rootPath: string): Promise<boolean> {
  try {
    const [target, root] = await Promise.all([realpath(candidate), realpath(rootPath)])
    return isPathWithinRoot(target, root)
  } catch {
    return false
  }
}

async function isRemoteKnowledgeAddItemsInput(input: unknown): Promise<boolean> {
  const parsed = knowledgeRequestSchemas['knowledge.add_items'].input.safeParse(input)
  if (!parsed.success) return false

  const accepted = await Promise.all(
    parsed.data.items.map((item) => {
      if (item.type === 'file') {
        if (item.data.indexedPath) return false
        return isExistingPathWithinRoot(item.data.path, application.getPath('feature.files.data'))
      }
      if (item.type === 'url') return !item.data.snapshotPath
      return item.type === 'note'
    })
  )
  return accepted.every(Boolean)
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

function remotePreferenceValue<K extends UnifiedPreferenceKeyType>(
  key: K,
  value: UnifiedPreferenceType[K]
): UnifiedPreferenceType[K] {
  return key === 'feature.notes.path' ? (application.getPath('feature.notes.data') as UnifiedPreferenceType[K]) : value
}

function remotePreferenceValues<T extends Partial<UnifiedPreferenceType>>(values: T): T {
  if (!Object.hasOwn(values, 'feature.notes.path')) return values
  return { ...values, 'feature.notes.path': application.getPath('feature.notes.data') }
}

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
  const roots = [
    application.getPath('feature.files.data'),
    application.getPath('feature.notes.data'),
    application.getPath('feature.knowledgebase.data')
  ].map((path) => resolve(path))
  if (!roots.some((root) => isPathWithinRoot(target, root))) {
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
  const safe = Array.from(basename(value), (character) => (character.charCodeAt(0) <= 31 ? '_' : character))
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid note name')
  return safe.replace(/\.md$/i, '')
}

interface WebEventClient {
  controller: ReadableStreamDefaultController<Uint8Array>
  listeners: Map<string, WebStreamListener>
}

type RemoteFileTreeRoute = 'file.tree.activate' | 'file.tree.create' | 'file.tree.dispose' | 'file.tree.rename'

const REMOTE_FILE_TREE_ROUTES = new Set<RemoteFileTreeRoute>([
  'file.tree.activate',
  'file.tree.create',
  'file.tree.dispose',
  'file.tree.rename'
])

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
  application.get('DirectoryTreeManager').disposeAllForRemoteClient(clientId)
  webEventClients.delete(clientId)
}

function remoteTreePath(candidate: string): string {
  const target = resolve(candidate)
  const roots = [
    application.getPath('app.userdata.data'),
    ...agentWorkspaceService.list({ includeSystem: true }).map((workspace) => workspace.path)
  ].map((root) => resolve(root))
  if (!roots.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
    throw new Error('Tree path is outside managed storage')
  }
  return target
}

function sendRemoteTreeMutation(clientId: string, payload: TreeMutationPushPayload): void {
  const client = webEventClients.get(clientId)
  if (!client) return
  client.controller.enqueue(
    encoder.encode(`${JSON.stringify({ type: 'event', data: { event: 'file.tree.mutation', payload } })}\n`)
  )
}

async function dispatchRemoteFileTree(route: RemoteFileTreeRoute, input: unknown, clientId: string) {
  try {
    if (!webEventClients.has(clientId)) throw new Error('Event stream is not connected')
    const manager = application.get('DirectoryTreeManager')
    if (route === 'file.tree.create') {
      const parsed = fileRequestSchemas[route].input.parse(input)
      const data = await manager.createRemote(
        clientId,
        (payload) => sendRemoteTreeMutation(clientId, payload),
        () => !webEventClients.has(clientId),
        remoteTreePath(parsed.rootPath),
        parsed.options
      )
      return { ok: true, data }
    }
    if (route === 'file.tree.activate') {
      const parsed = fileRequestSchemas[route].input.parse(input)
      return { ok: true, data: manager.activateRemoteTree(parsed.treeId, parsed.revision, clientId) }
    }
    if (route === 'file.tree.rename') {
      const parsed = fileRequestSchemas[route].input.parse(input)
      return {
        ok: true,
        data: manager.renameRemote(parsed.treeId, remoteTreePath(parsed.oldPath), parsed.newName, clientId)
      }
    }
    const parsed = fileRequestSchemas[route].input.parse(input)
    manager.disposeRemote(parsed.treeId, clientId)
    return { ok: true, data: undefined }
  } catch (error) {
    return { ok: false, error: IpcError.from(error).toJSON() }
  }
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
      const request = body as { route: string; input: unknown; clientId?: string }
      if (REMOTE_FILE_TREE_ROUTES.has(request.route as RemoteFileTreeRoute)) {
        return dispatchRemoteFileTree(request.route as RemoteFileTreeRoute, request.input, request.clientId ?? '')
      }
      if (request.route === 'knowledge.add_items') {
        if (!(await isRemoteKnowledgeAddItemsInput(request.input))) {
          set.status = 403
          return { error: 'Route is not available to remote clients' }
        }
        return application.get('IpcApiService').requestFromRemote(request.route, request.input)
      }
      if (request.route === 'binary.install_tool' || request.route === 'binary.remove_tool') {
        if (!isRemoteCodeOwnedBinaryInput(request.route, request.input)) {
          set.status = 403
          return { error: 'Route is not available to remote clients' }
        }
        return application.get('IpcApiService').requestFromRemote(request.route, request.input)
      }
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
          return { data: remotePreferenceValue(request.key, preferences.get(request.key)) }
        case 'set':
          await preferences.set(request.key, request.value as never)
          return { data: null }
        case 'getMultipleRaw':
          return { data: remotePreferenceValues(preferences.getMultipleRaw(request.keys)) }
        case 'setMultiple':
          await preferences.setMultiple(request.updates)
          return { data: null }
        case 'getAll':
          return { data: remotePreferenceValues(preferences.getAll()) }
      }
    },
    { detail: { hide: true } }
  )
