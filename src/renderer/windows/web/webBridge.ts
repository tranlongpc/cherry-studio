import type { ActiveExecution, TopicStreamStatus } from '@shared/ai/transport'
import type { DataRequest, DataResponse } from '@shared/data/api/types'
import type { CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type {
  UnifiedPreferenceKeyType,
  UnifiedPreferenceMultipleResultType,
  UnifiedPreferenceType
} from '@shared/data/preference/preferenceTypes'
import { ThemeMode } from '@shared/data/preference/preferenceTypes'

const TOKEN_STORAGE_KEY = 'cherry-web-token'

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

export function getWebToken(): string | null {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY)
}

export function clearWebToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  eventStreamController?.abort()
  eventStreamController = null
  eventStreamReady = null
  topicSubscriptionCounts.clear()
  activeExecutionsByTopic.clear()
}

export async function authenticateWebToken(token: string): Promise<void> {
  const normalized = token.trim()
  const response = await fetch('/web/api/session', {
    method: 'POST',
    headers: { authorization: `Bearer ${normalized}` }
  })
  if (!response.ok) throw new Error(response.status === 401 ? 'API key is required' : 'API key is not valid')
  sessionStorage.setItem(TOKEN_STORAGE_KEY, normalized)
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const token = getWebToken()
  if (!token) throw new Error('Sign in to Cherry Studio Web first')

  const response = await fetch(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
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

function handleEventMessage(raw: string): void {
  const message = JSON.parse(raw)
  if (message.type === 'cache') {
    cacheSyncListeners.forEach((listener) => listener(message.data))
    return
  }
  if (message.type === 'event') {
    if (message.data.event.startsWith('ai.stream.')) publishTopicStatus(message.data.event, message.data.payload)
    eventListeners.get(message.data.event)?.forEach((listener) => listener(message.data.payload))
  }
}

function ensureEventStream(): Promise<void> {
  const token = getWebToken()
  if (!token) throw new Error('Sign in to Cherry Studio Web first')
  if (eventStreamReady) return eventStreamReady

  eventStreamController = new AbortController()
  eventStreamReady = (async () => {
    const response = await fetch(
      `/web/api/events?clientId=${encodeURIComponent(eventClientId)}&token=${encodeURIComponent(token)}`,
      { signal: eventStreamController!.signal }
    )
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
