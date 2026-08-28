import type { ActiveExecution, TopicStreamStatus } from '@shared/ai/transport'
import type { DataRequest, DataResponse } from '@shared/data/api/types'
import type { CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type {
  UnifiedPreferenceKeyType,
  UnifiedPreferenceMultipleResultType,
  UnifiedPreferenceType
} from '@shared/data/preference/preferenceTypes'
import { ThemeMode } from '@shared/data/preference/preferenceTypes'
import type { FileMetadata } from '@shared/data/types/legacyFile'
import type { CreateInternalEntryIpcParams, GetPhysicalPathIpcParams } from '@shared/types/file'

type Listener = (...args: any[]) => void
const eventListeners = new Map<string, Set<(payload: unknown) => void>>()
const cacheSyncListeners = new Set<(message: CacheSyncMessage) => void>()
const activeExecutionsByTopic = new Map<string, Map<string, ActiveExecution>>()
const eventClientId = crypto.randomUUID()
const topicSubscriptionCounts = new Map<string, number>()
let eventStreamReady: Promise<void> | null = null
let eventStreamController: AbortController | null = null

type WebAiStreamEvent = {
  topicId: string
  executionId?: string
  attemptId?: number
  anchorMessageId?: string
  isTopicDone?: boolean
  status?: 'success' | 'paused'
}

function publishTopicStatus(eventName: string, event: WebAiStreamEvent): void {
  const executions = activeExecutionsByTopic.get(event.topicId) ?? new Map<string, ActiveExecution>()
  if (event.executionId && event.attemptId !== undefined) {
    const execution: ActiveExecution = {
      executionId: event.executionId as ActiveExecution['executionId'],
      attemptId: event.attemptId,
      ...(event.anchorMessageId ? { anchorMessageId: event.anchorMessageId } : {})
    }
    if (eventName === 'ai.stream.chunk') executions.set(event.executionId, execution)
    else executions.delete(event.executionId)
  }

  if (event.isTopicDone) executions.clear()
  if (executions.size > 0) activeExecutionsByTopic.set(event.topicId, executions)
  else activeExecutionsByTopic.delete(event.topicId)

  const status: TopicStreamStatus =
    eventName === 'ai.stream.error'
      ? 'error'
      : eventName === 'ai.stream.done'
        ? event.status === 'paused'
          ? 'aborted'
          : 'done'
        : 'streaming'
  const message: CacheSyncMessage = {
    type: 'shared',
    key: `topic.stream.statuses.${event.topicId}`,
    value: {
      status,
      activeExecutions: [...executions.values()],
      awaitingApprovalAnchors: []
    }
  }
  cacheSyncListeners.forEach((listener) => listener(message))
}

export function clearWebSession(): void {
  eventStreamController?.abort()
  eventStreamController = null
  eventStreamReady = null
  topicSubscriptionCounts.clear()
  activeExecutionsByTopic.clear()
}

export async function authenticateWebCredentials(email: string, password: string): Promise<void> {
  const response = await fetch('/web/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password })
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined)
    throw new Error(payload?.error ?? `Request failed with status ${response.status}`)
  }
}

export async function authenticateWebSession(): Promise<void> {
  const response = await fetch('/web/api/session')
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  const payload = await response.json()
  if (!response.ok) throw new Error(payload?.error ?? `Request failed with status ${response.status}`)
  return payload as T
}

async function preferenceRequest<T>(body: unknown): Promise<T> {
  const response = await request<{ data: T }>('/web/api/preference', body)
  return response.data
}

async function uploadBrowserFiles(files: File[]): Promise<FileMetadata[]> {
  return Promise.all(
    files.map(async (file) => {
      const response = await fetch('/web/api/files', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name)
        },
        body: file
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error ?? `Upload failed with status ${response.status}`)
      return payload as FileMetadata
    })
  )
}

function selectBrowserFiles(options?: { filters?: Array<{ extensions: string[] }>; properties?: string[] }) {
  return new Promise<FileMetadata[] | null>((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options?.properties?.includes('multiSelections') ?? false
    const extensions = options?.filters?.flatMap((filter) => filter.extensions) ?? []
    if (extensions.length > 0 && !extensions.includes('*')) {
      input.accept = extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)).join(',')
    }
    input.style.display = 'none'
    document.body.append(input)

    let settled = false
    const finish = (value: FileMetadata[] | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      if (files.length === 0) {
        finish(null)
        return
      }
      void uploadBrowserFiles(files)
        .then(finish)
        .catch(reject)
        .finally(() => input.remove())
    })
    input.addEventListener('cancel', () => finish(null))
    input.click()
  })
}

function downloadBrowserFile(filename: string, content: string | ArrayBufferView | Blob): Promise<string> {
  const blob =
    content instanceof Blob
      ? content
      : typeof content === 'string'
        ? new Blob([content], { type: 'text/plain;charset=utf-8' })
        : new Blob([new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice().buffer])
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.split(/[\\/]/).pop() || 'download'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  queueMicrotask(() => URL.revokeObjectURL(url))
  return Promise.resolve(anchor.download)
}

async function downloadBrowserImage(filename: string, data: string): Promise<boolean> {
  const response = await fetch(data)
  await downloadBrowserFile(filename, await response.blob())
  return true
}

function handleEventMessage(raw: string): void {
  const message = JSON.parse(raw)
  if (message.type === 'cache') {
    cacheSyncListeners.forEach((listener) => listener(message.data))
    return
  }
  if (message.type === 'event') {
    if (message.data.event.startsWith('ai.stream.')) publishTopicStatus(message.data.event, message.data.payload)
    eventListeners.get(message.data.event)?.forEach((listener) => listener(message.data.payload))
    if (message.data.payload?.isTopicDone && String(message.data.payload.topicId).startsWith('translate:')) {
      void unsubscribeTopic(message.data.payload.topicId)
    }
  }
}

function ensureEventStream(): Promise<void> {
  if (eventStreamReady) return eventStreamReady

  eventStreamController = new AbortController()
  eventStreamReady = (async () => {
    const response = await fetch('/web/api/events', {
      headers: { 'x-cherry-web-client-id': eventClientId },
      signal: eventStreamController.signal
    })
    if (!response.ok || !response.body) throw new Error(`Event stream failed with status ${response.status}`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += value
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line) {
              const message = JSON.parse(line)
              if (message.type === 'ready') markReady()
              else handleEventMessage(line)
            }
            newline = buffer.indexOf('\n')
          }
        }
      } finally {
        eventStreamReady = null
        eventStreamController = null
      }
    })()
    await ready
  })()
  return eventStreamReady
}

async function subscribeTopic(topicId: string): Promise<{ status: 'attached'; bufferedChunks: [] }> {
  await ensureEventStream()
  const count = topicSubscriptionCounts.get(topicId) ?? 0
  topicSubscriptionCounts.set(topicId, count + 1)
  if (count > 0) return { status: 'attached', bufferedChunks: [] }
  return request('/web/api/stream/subscription', { clientId: eventClientId, topicId, action: 'subscribe' })
}

async function unsubscribeTopic(topicId: string): Promise<void> {
  const count = topicSubscriptionCounts.get(topicId) ?? 0
  if (count > 1) {
    topicSubscriptionCounts.set(topicId, count - 1)
    return
  }
  topicSubscriptionCounts.delete(topicId)
  if (!eventStreamReady) return
  await request('/web/api/stream/subscription', { clientId: eventClientId, topicId, action: 'unsubscribe' })
}

function unsupported(name: string) {
  return () => Promise.reject(new Error(`${name} is not available in the web client`))
}

export function installWebBridge(): void {
  const noEvents: (...args: Listener[]) => () => void = () => () => {}
  const api = {
    cache: {
      broadcastSync: () => {},
      getAllShared: async () => ({}),
      onSync: (callback: (message: CacheSyncMessage) => void) => {
        cacheSyncListeners.add(callback)
        return () => cacheSyncListeners.delete(callback)
      }
    },
    dataApi: {
      request: (dataRequest: DataRequest): Promise<DataResponse> => request('/web/api/data', dataRequest),
      onDataChanged: noEvents
    },
    file: {
      select: selectBrowserFiles,
      createInternalEntry: (params: CreateInternalEntryIpcParams) =>
        request('/web/api/file', { action: 'createInternalEntry', params }),
      getPhysicalPath: ({ id }: GetPhysicalPathIpcParams) =>
        request<{ data: string }>('/web/api/file', { action: 'getPhysicalPath', id }).then(({ data }) => data),
      checkFileName: (dirPath: string, fileName: string, isFile: boolean) =>
        request('/web/api/file', { action: 'notesCheckName', dirPath, fileName, isFile }),
      write: (filePath: string, content: string) =>
        request('/web/api/file', { action: 'notesWrite', filePath, content }),
      mkdir: (dirPath: string) => request('/web/api/file', { action: 'notesMkdir', dirPath }),
      validateNotesDirectory: (dirPath: string) =>
        request('/web/api/file', { action: 'notesValidateDirectory', dirPath }),
      save: (filename: string, content: string | ArrayBufferView) => downloadBrowserFile(filename, content),
      saveImage: (filename: string, data: string) => downloadBrowserImage(filename, data),
      readExternal: (filePath: string) =>
        request<{ data: string }>('/web/api/file', { action: 'readManaged', filePath, encoding: true }).then(
          ({ data }) => data
        ),
      selectFolder: async () => null,
      open: async () => null,
      openPath: async () => {},
      showInFolder: async () => {},
      getPathForFile: () => ''
    },
    fs: {
      readText: (filePath: string) =>
        request<{ data: string }>('/web/api/file', { action: 'readManaged', filePath, encoding: true }).then(
          ({ data }) => data
        ),
      read: (filePath: string) =>
        request<{ data: number[] }>('/web/api/file', { action: 'readManaged', filePath }).then(
          ({ data }) => new Uint8Array(data)
        )
    },
    ipcApi: {
      request: (route: string, input: any) => {
        if (route === 'system.get_native_theme') {
          return Promise.resolve(
            window.matchMedia('(prefers-color-scheme: dark)').matches ? ThemeMode.dark : ThemeMode.light
          )
        }
        if (route === 'system.get_device_type') return Promise.resolve('web')
        if (route === 'system.shell.open_website') {
          window.open(input, '_blank', 'noopener,noreferrer')
          return Promise.resolve(undefined)
        }
        if (route === 'navigation.protocol_dispatch_ready' || route === 'navigation.ack_open_route') {
          return Promise.resolve({ ok: true, data: undefined })
        }
        if (route === 'translate.open') {
          return subscribeTopic(input.streamId)
            .then(() => request('/web/api/translate/open', { clientId: eventClientId, ...input }))
            .then((data) => ({ ok: true, data }))
        }
        if (route === 'ai.stream.open') {
          return ensureEventStream()
            .then(() => request('/web/api/stream/open', input))
            .then((data) => ({ ok: true, data }))
        }
        if (route === 'ai.stream.attach') {
          return subscribeTopic(input.topicId).then((data) => ({ ok: true, data }))
        }
        if (route === 'ai.stream.detach') {
          return unsubscribeTopic(input.topicId).then(() => ({ ok: true, data: undefined }))
        }
        return request('/web/api/ipc', { route, input })
      },
      on: (event: string, callback: (payload: unknown) => void) => {
        const listeners = eventListeners.get(event) ?? new Set()
        listeners.add(callback)
        eventListeners.set(event, listeners)
        return () => {
          listeners.delete(callback)
          if (listeners.size === 0) eventListeners.delete(event)
        }
      }
    },
    preference: {
      get: <K extends UnifiedPreferenceKeyType>(key: K): Promise<UnifiedPreferenceType[K]> =>
        preferenceRequest({ action: 'get', key }),
      set: <K extends UnifiedPreferenceKeyType>(key: K, value: UnifiedPreferenceType[K]): Promise<void> =>
        preferenceRequest({ action: 'set', key, value }),
      getMultipleRaw: <K extends UnifiedPreferenceKeyType>(
        keys: K[]
      ): Promise<UnifiedPreferenceMultipleResultType<K>> => preferenceRequest({ action: 'getMultipleRaw', keys }),
      setMultiple: (updates: Partial<UnifiedPreferenceType>): Promise<void> =>
        preferenceRequest({ action: 'setMultiple', updates }),
      getAll: (): Promise<UnifiedPreferenceType> => preferenceRequest({ action: 'getAll' }),
      subscribe: async () => {},
      onChanged: noEvents
    },
    shell: {
      openExternal: (url: string) => {
        window.open(url, '_blank', 'noopener,noreferrer')
        return Promise.resolve()
      }
    },
    storageMonitor: {
      getHealth: unsupported('storageMonitor.getHealth'),
      onHealthChange: noEvents
    },
    application: {
      preventQuit: async () => 'web-client',
      allowQuit: async () => {},
      relaunch: async () => window.location.reload()
    },
    system: {
      getHostname: async () => window.location.hostname
    }
  }

  const unavailableApi = new Proxy(api, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      return new Proxy(
        {},
        {
          get: (_nestedTarget, nestedProperty) => unsupported(`${String(property)}.${String(nestedProperty)}`)
        }
      )
    }
  })

  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      ipcRenderer: { invoke: async () => undefined, on: () => {}, send: () => {} },
      process: { env: { NODE_ENV: import.meta.env.DEV ? 'development' : 'production' }, platform: 'web' }
    }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: unavailableApi })
}
