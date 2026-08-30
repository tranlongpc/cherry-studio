import { scryptSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { application } from '@application'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration tests that drive the real Elysia app via `app.handle(Request)`.
 *
 * They verify the idiomatic route wiring end-to-end: declarative schema
 * validation (auto-400), the per-dialect `onError` envelopes (OpenAI vs
 * Anthropic), auth short-circuiting, and `status()`-based responses.
 * (Knowledge route behaviour is covered in ../knowledge/__tests__.)
 */

// All mock fns live in vi.hoisted so the (hoisted) vi.mock factories can close
// over them without a TDZ error.
const {
  mockPreferenceGet,
  mockPreferenceGetAll,
  mockPreferenceGetMultipleRaw,
  mockPreferenceSet,
  mockDataApiRequest,
  mockIpcApiRequest,
  mockCreateInternalEntry,
  mockGetPhysicalPath,
  mockTranslateOpen,
  mockProcessMessage,
  mockGetModels,
  mockIsInternalRequestToken,
  mockTreeCreateRemote,
  mockTreeActivateRemote,
  mockTreeDisposeRemote,
  mockTreeDisposeAllRemote,
  mockTreeRenameRemote,
  mockAgentWorkspaceList
} = vi.hoisted(() => ({
  mockPreferenceGet: vi.fn<(key: string) => unknown>(() => 'test-key'),
  mockPreferenceGetAll: vi.fn<() => Record<string, unknown>>(() => ({ 'app.language': 'en-US' })),
  mockPreferenceGetMultipleRaw: vi.fn<() => Record<string, unknown>>(() => ({})),
  mockPreferenceSet: vi.fn(async () => {}),
  mockDataApiRequest: vi.fn(async (request: unknown) => ({ id: 'request-1', status: 200, data: request })),
  mockIpcApiRequest: vi.fn(async (route: string, input: unknown) => ({ ok: true, data: { route, input } })),
  mockCreateInternalEntry: vi.fn(async () => ({
    id: '01912345-6789-7abc-8def-0123456789ab',
    createdAt: 1_700_000_000_000
  })),
  mockGetPhysicalPath: vi.fn(() => '/mock/Data/Files/upload.txt'),
  mockTranslateOpen: vi.fn(() => ({ streamId: 'translate:1' })),
  mockProcessMessage: vi.fn<(config: unknown) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  ),
  mockGetModels: vi.fn(async () => ({ object: 'list', data: [{ id: 'openai:gpt-4' }] })),
  mockIsInternalRequestToken: vi.fn((candidate: string | undefined) => candidate === 'internal-request-token'),
  mockTreeCreateRemote: vi.fn(async () => ({
    treeId: 'tree-1',
    revision: 0,
    snapshot: { kind: 'directory', path: '/mock/app.userdata.data/Agents', basename: 'Agents', children: {} }
  })),
  mockTreeActivateRemote: vi.fn(() => true),
  mockTreeDisposeRemote: vi.fn(() => true),
  mockTreeDisposeAllRemote: vi.fn(),
  mockTreeRenameRemote: vi.fn(() => true),
  mockAgentWorkspaceList: vi.fn(() => [
    {
      id: 'workspace-1',
      name: 'project',
      path: '/mock/registered-workspaces/project',
      type: 'user',
      orderKey: 'a0',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z'
    }
  ])
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const overrides = {
    PreferenceService: {
      get: mockPreferenceGet,
      getAll: mockPreferenceGetAll,
      getMultipleRaw: mockPreferenceGetMultipleRaw,
      set: mockPreferenceSet
    },
    DataApiService: { getApiServer: () => ({ handleRequest: mockDataApiRequest }) },
    IpcApiService: { requestFromRemote: mockIpcApiRequest },
    FileManager: { createInternalEntry: mockCreateInternalEntry, getPhysicalPath: mockGetPhysicalPath },
    ApiGatewayService: { isInternalRequestToken: mockIsInternalRequestToken },
    DirectoryTreeManager: {
      createRemote: mockTreeCreateRemote,
      activateRemoteTree: mockTreeActivateRemote,
      disposeRemote: mockTreeDisposeRemote,
      disposeAllForRemoteClient: mockTreeDisposeAllRemote,
      renameRemote: mockTreeRenameRemote
    }
  }
  return mockApplicationFactory(overrides)
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
  }
}))

vi.mock('@main/services/translate/translateService', () => ({
  translateService: { openWithListener: mockTranslateOpen }
}))

vi.mock('@data/services/AgentWorkspaceService', () => ({
  agentWorkspaceService: { list: mockAgentWorkspaceList }
}))

// Route `detail.description` fields hold i18n *keys*; openapiDocs.ts resolves them
// per request via `t()`. Stub `t` as `key::lang` (rather than a pure passthrough) so
// the docs tests below can assert the requested language actually reached translation
// — and so a key that never went through `t()` is visibly missing its `::lang` suffix
// — without needing the real catalog. `getAppLanguage`/`SUPPORTED_LANGUAGES` back the
// docs' default language + language-switcher list.
vi.mock('@main/i18n', () => ({
  t: (key: string, _params?: unknown, lang?: string) => (lang ? `${key}::${lang}` : key),
  getAppLanguage: () => 'en-US',
  SUPPORTED_LANGUAGES: ['en-US', 'zh-CN']
}))

// Heavy services are stubbed so building the app + exercising handlers never
// touches the real AiService / data layer.
vi.mock('../../proxyStream', () => ({
  processMessage: mockProcessMessage,
  default: { processMessage: mockProcessMessage }
}))

vi.mock('../../utils/models', () => ({
  getModels: mockGetModels
}))

// Knowledge routes use the v2 KB service (pulled in by buildApp); stubbed so
// building the app stays hermetic (knowledge behaviour tested separately).
vi.mock('@data/services/KnowledgeBaseService', () => ({
  knowledgeBaseService: { list: vi.fn(async () => ({ items: [], total: 0, page: 1 })), getById: vi.fn() }
}))

import { buildApp } from '../../app'
import { clearWebSessions } from '../../webAuth'

const AUTH = { 'content-type': 'application/json', 'x-api-key': 'test-key' }

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown, headers: Record<string, string> = AUTH) {
  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }))
}
function get(app: ReturnType<typeof buildApp>, path: string, headers: Record<string, string> = AUTH) {
  return app.handle(new Request(`http://localhost${path}`, { method: 'GET', headers }))
}
async function read(res: Response): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() }
}

describe('API gateway routes (integration)', () => {
  let app: ReturnType<typeof buildApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPreferenceGet.mockReturnValue('test-key')
    app = buildApp()
  })

  describe('public routes', () => {
    it('GET /health → 200', async () => {
      const { status, body } = await read(await get(app, '/health', {}))
      expect(status).toBe(200)
      expect(body.status).toBe('ok')
    })

    it('GET / → 200 API info', async () => {
      const { status, body } = await read(await get(app, '/', {}))
      expect(status).toBe(200)
      expect(body.name).toBe('Cherry Studio API')
      expect(body.endpoints).toBeDefined()
    })

    it('OpenAPI spec advertises an absolute server URL from host/port', async () => {
      // Scalar renders curl examples against `servers[0].url`; an absolute URL
      // keeps the health-check example copyable (`curl http://.../health`)
      // instead of a bare relative path (`curl /health`).
      const { body } = await read(await get(app, '/openapi/json', {}))
      expect(body.servers).toEqual([{ url: 'http://127.0.0.1:23333' }])

      const custom = await read(await get(buildApp({ host: '0.0.0.0', port: 8080 }), '/openapi/json', {}))
      expect(custom.body.servers).toEqual([{ url: 'http://0.0.0.0:8080' }])
    })
  })

  describe('web client bridge', () => {
    let cookie: string
    let setCookie: string

    beforeEach(async () => {
      clearWebSessions()
      vi.stubEnv('CHERRY_WEB_EMAIL', 'user@example.com')
      vi.stubEnv(
        'CHERRY_WEB_PASSWORD_HASH',
        `scrypt$test-salt$${scryptSync('secret-password', 'test-salt', 64).toString('hex')}`
      )
      const response = await post(
        app,
        '/web/api/session',
        { email: 'user@example.com', password: 'secret-password' },
        { 'content-type': 'application/json' }
      )
      setCookie = response.headers.get('set-cookie')!
      cookie = setCookie.split(';')[0]
    })

    const webPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      post(app, path, body, { 'content-type': 'application/json', cookie, ...headers })

    it('validates credentials through the web session endpoint', async () => {
      const invalid = await read(
        await post(
          app,
          '/web/api/session',
          { email: 'user@example.com', password: 'wrong-password' },
          { 'content-type': 'application/json' }
        )
      )
      expect(invalid.status).toBe(401)
      expect((await get(app, '/web/api/session', { cookie })).status).toBe(200)
    })

    it('creates an HttpOnly same-site session cookie without exposing the gateway key', () => {
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).toContain('Path=/web/api')
      expect(setCookie).not.toContain('test-key')
    })

    it('does not accept the event client identifier from the URL', async () => {
      const response = await get(app, '/web/api/events?clientId=event-client', { cookie })

      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Missing clientId')
    })

    it('streams web events through proxies and keeps idle connections alive', async () => {
      vi.useFakeTimers()
      const response = await get(app, '/web/api/events', { cookie, 'x-cherry-web-client-id': 'heartbeat-client' })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      try {
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        await expect(reader.read()).resolves.toMatchObject({ done: false })

        await vi.advanceTimersByTimeAsync(15_000)

        const heartbeat = await reader.read()
        expect(decoder.decode(heartbeat.value)).toBe(`${JSON.stringify({ type: 'heartbeat' })}\n`)
      } finally {
        await reader.cancel()
        vi.useRealTimers()
      }
    })

    it('requires authentication for web API requests', async () => {
      const { status, body } = await read(
        await post(app, '/web/api/preference', { action: 'getAll' }, { 'content-type': 'application/json' })
      )
      expect(status).toBe(401)
      expect(body).toEqual({ error: 'Unauthorized' })
    })

    it('does not accept the API Gateway key as web authentication', async () => {
      const response = await post(app, '/web/api/preference', { action: 'getAll' })
      expect(response.status).toBe(401)
    })

    it('forwards authenticated DataApi requests through the existing server', async () => {
      const request = { id: 'request-1', method: 'GET', path: '/assistants' }
      const { status, body } = await read(await webPost('/web/api/data', request))
      expect(status).toBe(200)
      expect(mockDataApiRequest).toHaveBeenCalledWith(request)
      expect(body.data).toEqual(request)
    })

    it('dispatches authenticated IpcApi requests without a window identity', async () => {
      const { status, body } = await read(
        await webPost('/web/api/ipc', { route: 'ai.agent.task.run', input: { agentId: 'a1', taskId: 't1' } })
      )
      expect(status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('ai.agent.task.run', { agentId: 'a1', taskId: 't1' })
      expect(body.ok).toBe(true)
    })

    it('allows creating a knowledge base from the web client', async () => {
      const input = { base: { name: 'Web knowledge', model: null } }
      const { status, body } = await read(await webPost('/web/api/ipc', { route: 'knowledge.create_base', input }))

      expect(status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('knowledge.create_base', input)
      expect(body.ok).toBe(true)
    })

    it('allows resolving a knowledge-managed source path by item id', async () => {
      const input = { itemId: 'item-1' }
      const { status } = await read(await webPost('/web/api/ipc', { route: 'knowledge.get_file_path', input }))

      expect(status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('knowledge.get_file_path', input)
    })

    it('allows adding browser-safe knowledge sources', async () => {
      const filesRoot = await mkdtemp(join(tmpdir(), 'cherry-web-files-'))
      const uploadedFile = join(filesRoot, 'upload.md')
      await writeFile(uploadedFile, '# Uploaded knowledge', 'utf8')
      vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) => {
        const root = key === 'feature.files.data' ? filesRoot : `/mock/${key}`
        return filename ? join(root, filename) : root
      })
      const input = {
        baseId: 'base-1',
        items: [
          {
            type: 'file',
            data: { source: 'upload.md', path: uploadedFile }
          },
          {
            type: 'note',
            data: { source: 'Web note', content: 'Knowledge content' }
          },
          {
            type: 'url',
            data: { source: 'https://example.com', url: 'https://example.com' }
          }
        ],
        conflictStrategy: 'detect'
      }

      try {
        const { status } = await read(await webPost('/web/api/ipc', { route: 'knowledge.add_items', input }))

        expect(status).toBe(200)
        expect(mockIpcApiRequest).toHaveBeenCalledWith('knowledge.add_items', input)
      } finally {
        vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) =>
          filename ? `/mock/${key}/${filename}` : `/mock/${key}`
        )
        await rm(filesRoot, { recursive: true, force: true })
      }
    })

    it.each([
      [{ type: 'file', data: { source: 'passwd', path: '/etc/passwd' } }],
      [
        {
          type: 'file',
          data: {
            source: 'upload.md',
            path: '/mock/feature.files.data/upload.md',
            indexedPath: '/mock/feature.knowledgebase.data/base-1/processed/upload.md'
          }
        }
      ],
      [
        {
          type: 'url',
          data: {
            source: 'https://example.com',
            url: 'https://example.com',
            snapshotPath: '/mock/feature.knowledgebase.data/base-1/raw/example.md'
          }
        }
      ],
      [{ type: 'directory', data: { source: '/Volumes/Data' } }]
    ])('rejects unsafe remote knowledge sources', async (item) => {
      const { status, body } = await read(
        await webPost('/web/api/ipc', {
          route: 'knowledge.add_items',
          input: { baseId: 'base-1', items: [item], conflictStrategy: 'detect' }
        })
      )

      expect(status).toBe(403)
      expect(body).toEqual({ error: 'Route is not available to remote clients' })
      expect(mockIpcApiRequest).not.toHaveBeenCalled()
    })

    it('rejects a knowledge source symlink that escapes managed file storage', async () => {
      const filesRoot = await mkdtemp(join(tmpdir(), 'cherry-web-files-'))
      const linkedFile = join(filesRoot, 'linked.md')
      await symlink('/etc/passwd', linkedFile)
      vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) => {
        const root = key === 'feature.files.data' ? filesRoot : `/mock/${key}`
        return filename ? join(root, filename) : root
      })

      try {
        const { status } = await read(
          await webPost('/web/api/ipc', {
            route: 'knowledge.add_items',
            input: {
              baseId: 'base-1',
              items: [{ type: 'file', data: { source: 'linked.md', path: linkedFile } }]
            }
          })
        )

        expect(status).toBe(403)
        expect(mockIpcApiRequest).not.toHaveBeenCalled()
      } finally {
        vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) =>
          filename ? `/mock/${key}/${filename}` : `/mock/${key}`
        )
        await rm(filesRoot, { recursive: true, force: true })
      }
    })

    it('creates a managed directory tree for the connected web event client', async () => {
      const events = await get(app, '/web/api/events', { cookie, 'x-cherry-web-client-id': 'client-1' })
      const input = { rootPath: '/mock/app.userdata.data/Agents' }
      const { status, body } = await read(
        await webPost('/web/api/ipc', { route: 'file.tree.create', input, clientId: 'client-1' })
      )

      expect(status).toBe(200)
      expect(body).toEqual({
        ok: true,
        data: {
          treeId: 'tree-1',
          revision: 0,
          snapshot: { kind: 'directory', path: input.rootPath, basename: 'Agents', children: {} }
        }
      })
      expect(mockTreeCreateRemote).toHaveBeenCalledWith(
        'client-1',
        expect.any(Function),
        expect.any(Function),
        input.rootPath,
        undefined
      )

      await events.body?.cancel()
      expect(mockTreeDisposeAllRemote).toHaveBeenCalledWith('client-1')
    })

    it('creates a directory tree for a registered agent workspace outside app storage', async () => {
      const events = await get(app, '/web/api/events', { cookie, 'x-cherry-web-client-id': 'client-1' })
      const input = { rootPath: '/mock/registered-workspaces/project' }
      const { status } = await read(
        await webPost('/web/api/ipc', { route: 'file.tree.create', input, clientId: 'client-1' })
      )

      expect(status).toBe(200)
      expect(mockTreeCreateRemote).toHaveBeenCalledWith(
        'client-1',
        expect.any(Function),
        expect.any(Function),
        input.rootPath,
        undefined
      )

      await events.body?.cancel()
    })

    it('rejects a directory tree outside app storage and registered agent workspaces', async () => {
      const events = await get(app, '/web/api/events', { cookie, 'x-cherry-web-client-id': 'client-1' })
      const { body } = await read(
        await webPost('/web/api/ipc', {
          route: 'file.tree.create',
          input: { rootPath: '/mock/registered-workspaces/project-copy' },
          clientId: 'client-1'
        })
      )

      expect(body).toMatchObject({ ok: false, error: { message: 'Tree path is outside managed storage' } })
      expect(mockTreeCreateRemote).not.toHaveBeenCalled()

      await events.body?.cancel()
    })

    it('rejects IpcApi routes outside the remote allowlist', async () => {
      const { status, body } = await read(
        await webPost('/web/api/ipc', { route: 'application.relaunch', input: undefined })
      )
      expect(status).toBe(403)
      expect(body).toEqual({ error: 'Route is not available to remote clients' })
      expect(mockIpcApiRequest).not.toHaveBeenCalled()
    })

    it('allows the read-only region route required by web bootstrap', async () => {
      const { status } = await read(await webPost('/web/api/ipc', { route: 'system.get_ip_country' }))
      expect(status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('system.get_ip_country', undefined)
    })

    it('allows retaining uploaded file entries by id', async () => {
      const input = { ids: ['019606a0-0000-7000-8000-000000000001'] }
      const { status } = await read(await webPost('/web/api/ipc', { route: 'file.batch_retain', input }))

      expect(status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('file.batch_retain', input)
    })

    it('allows polling trace data without exposing trace cleanup', async () => {
      const input = { topicId: '123e4567-e89b-42d3-a456-426614174000', traceId: 'a'.repeat(32) }
      const { status } = await read(await webPost('/web/api/ipc', { route: 'trace.get_data', input }))

      expect(status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('trace.get_data', input)
    })

    it('allows managing code-owned binary tools without exposing custom recipes', async () => {
      const names = ['uv', 'bun']
      const snapshots = await read(await webPost('/web/api/ipc', { route: 'binary.get_tool_snapshots', input: names }))

      expect(snapshots.status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('binary.get_tool_snapshots', names)

      mockIpcApiRequest.mockClear()
      const install = await read(
        await webPost('/web/api/ipc', {
          route: 'binary.install_tool',
          input: { name: 'bun', targetVersion: 'latest' }
        })
      )
      const remove = await read(await webPost('/web/api/ipc', { route: 'binary.remove_tool', input: { name: 'bun' } }))
      const custom = await read(
        await webPost('/web/api/ipc', { route: 'binary.install_tool', input: { name: 'custom-tool' } })
      )

      expect(install.status).toBe(200)
      expect(remove.status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith('binary.install_tool', { name: 'bun', targetVersion: 'latest' })
      expect(mockIpcApiRequest).toHaveBeenCalledWith('binary.remove_tool', { name: 'bun' })
      expect(custom.status).toBe(403)
      expect(custom.body).toEqual({ error: 'Route is not available to remote clients' })
    })

    it.each([
      ['ai.agent.session.prewarm', { sessionId: 'session-1' }],
      ['ai.tool.respond_approval', { approvalId: 'approval-1', approved: true }],
      ['app.cache_cleanup.inspect', { groups: ['normal_cache'] }],
      ['binary.get_latest_versions', false],
      ['channel.get_statuses', undefined],
      ['file_processing.list_available_processors', undefined],
      ['file.batch_get_dangling_states', { ids: ['01912345-6789-7abc-8def-0123456789ab'] }],
      [
        'file.batch_get_metadata',
        { items: [{ key: 'file-1', handle: { type: 'entry', id: '01912345-6789-7abc-8def-0123456789ab' } }] }
      ],
      ['file.batch_get_physical_paths', { ids: ['01912345-6789-7abc-8def-0123456789ab'] }],
      ['knowledge.list_item_chunks', { baseId: 'base-1', itemId: 'item-1' }],
      ['knowledge.search', { baseId: 'base-1', query: 'test' }],
      ['local_model.get_acceleration_capability', undefined],
      ['local_model.get_status', { model: 'ocr' }],
      ['mcp.server.get_version', { serverId: 'server-1' }],
      ['mcp.server.list_prompts', { serverId: 'server-1' }],
      ['mcp.server.list_resources', { serverId: 'server-1' }],
      ['mcp.server.read_resource_preview', { serverId: 'server-1', uri: 'file:///readme', maxChars: 4000 }],
      ['mcp.server.refresh_tools', { serverId: 'server-1' }],
      ['mcp.tool.abort_call', { callId: 'call-1', scope: 'topic-1' }],
      ['ovms.get_status', undefined],
      ['ovms.is_supported', undefined],
      ['skill.reconcile', {}]
    ])('allows the constrained web route %s', async (route, input) => {
      const { status } = await read(await webPost('/web/api/ipc', { route, input }))

      expect(status).toBe(200)
      expect(mockIpcApiRequest).toHaveBeenCalledWith(route, input)
    })

    it('keeps remote CLI execution unavailable', async () => {
      const { status, body } = await read(
        await webPost('/web/api/ipc', {
          route: 'code_cli.run',
          input: { cliTool: 'claude-code', prompt: 'run' }
        })
      )

      expect(status).toBe(403)
      expect(body).toEqual({ error: 'Route is not available to remote clients' })
      expect(mockIpcApiRequest).not.toHaveBeenCalled()
    })

    it('reads and writes preferences through the main preference service', async () => {
      const readResult = await read(await webPost('/web/api/preference', { action: 'getAll' }))
      expect(readResult.body).toEqual({ data: { 'app.language': 'en-US' } })

      const writeResult = await webPost('/web/api/preference', {
        action: 'set',
        key: 'app.language',
        value: 'vi-VN'
      })
      expect(writeResult.status).toBe(200)
      expect(mockPreferenceSet).toHaveBeenCalledWith('app.language', 'vi-VN')
    })

    it('keeps the desktop notes path out of web preference reads', async () => {
      mockPreferenceGet.mockReturnValueOnce('/mock/desktop-notes')
      mockPreferenceGetMultipleRaw.mockReturnValueOnce({
        'app.language': 'en-US',
        'feature.notes.path': '/mock/desktop-notes'
      })
      mockPreferenceGetAll.mockReturnValueOnce({
        'app.language': 'en-US',
        'feature.notes.path': '/mock/desktop-notes'
      })

      const single = await read(await webPost('/web/api/preference', { action: 'get', key: 'feature.notes.path' }))
      const multiple = await read(
        await webPost('/web/api/preference', {
          action: 'getMultipleRaw',
          keys: ['app.language', 'feature.notes.path']
        })
      )
      const all = await read(await webPost('/web/api/preference', { action: 'getAll' }))

      expect(single.body).toEqual({ data: '/mock/feature.notes.data' })
      expect(multiple.body).toEqual({
        data: { 'app.language': 'en-US', 'feature.notes.path': '/mock/feature.notes.data' }
      })
      expect(all.body).toEqual({
        data: { 'app.language': 'en-US', 'feature.notes.path': '/mock/feature.notes.data' }
      })
    })

    it('stores uploaded browser files in Cherry-managed storage', async () => {
      const response = await app.handle(
        new Request('http://localhost/web/api/files', {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/octet-stream',
            'x-file-name': encodeURIComponent('notes.txt')
          },
          body: new Uint8Array([104, 101, 108, 108, 111])
        })
      )
      const body = await response.json()

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(mockCreateInternalEntry).toHaveBeenCalledWith({
        source: 'bytes',
        data: new Uint8Array([104, 101, 108, 108, 111]),
        name: 'notes',
        ext: 'txt',
        cleanupPolicy: 'delete_when_unreferenced'
      })
      expect(body).toEqual(
        expect.objectContaining({ name: 'notes.txt', path: '/mock/Data/Files/upload.txt', ext: '.txt', type: 'text' })
      )
    })

    it('bridges composer file entry creation and physical path lookup', async () => {
      mockCreateInternalEntry.mockResolvedValueOnce({
        id: '01912345-6789-7abc-8def-0123456789ab',
        createdAt: 1_700_000_000_000
      })
      const create = await read(
        await webPost('/web/api/file', {
          action: 'createInternalEntry',
          params: {
            source: 'path',
            path: '/mock/Data/Files/upload.txt',
            cleanupPolicy: 'delete_when_unreferenced'
          }
        })
      )
      const physical = await read(
        await webPost('/web/api/file', {
          action: 'getPhysicalPath',
          id: '01912345-6789-7abc-8def-0123456789ab'
        })
      )

      expect(create.status).toBe(200)
      expect(mockCreateInternalEntry).toHaveBeenLastCalledWith({
        source: 'path',
        path: '/mock/Data/Files/upload.txt',
        cleanupPolicy: 'delete_when_unreferenced'
      })
      expect(physical.body).toEqual({ data: '/mock/Data/Files/upload.txt' })
    })

    it('rejects Notes writes outside Cherry-managed Notes storage', async () => {
      const response = await webPost('/web/api/file', {
        action: 'notesWrite',
        filePath: '/tmp/outside.md',
        content: 'blocked'
      })
      expect(response.status).toBe(500)
    })

    it('reads knowledge-managed files and rejects paths outside managed storage', async () => {
      const knowledgeRoot = await mkdtemp(join(tmpdir(), 'cherry-web-knowledge-'))
      const knowledgeFile = join(knowledgeRoot, 'base-1', 'raw', 'AGENTS.md')
      await mkdir(dirname(knowledgeFile), { recursive: true })
      await writeFile(knowledgeFile, '# Knowledge source', 'utf8')
      vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) => {
        const root = key === 'feature.knowledgebase.data' ? knowledgeRoot : `/mock/${key}`
        return filename ? join(root, filename) : root
      })

      try {
        const managed = await read(
          await webPost('/web/api/file', {
            action: 'readManaged',
            filePath: knowledgeFile,
            encoding: true
          })
        )
        const response = await webPost('/web/api/file', {
          action: 'readManaged',
          filePath: '/etc/passwd',
          encoding: true
        })

        expect(managed.status).toBe(200)
        expect(managed.body).toEqual({ data: '# Knowledge source' })
        expect(response.status).toBe(500)
      } finally {
        vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) =>
          filename ? `/mock/${key}/${filename}` : `/mock/${key}`
        )
        await rm(knowledgeRoot, { recursive: true, force: true })
      }
    })

    it('reads files from registered agent workspaces', async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'cherry-web-workspace-'))
      const workbookPath = join(workspaceRoot, 'table.xlsx')
      await writeFile(workbookPath, new Uint8Array([80, 75, 3, 4]))
      mockAgentWorkspaceList.mockReturnValueOnce([
        {
          id: 'workspace-2',
          name: 'agent-workspace',
          path: workspaceRoot,
          type: 'user',
          orderKey: 'a1',
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:00:00.000Z'
        }
      ])

      try {
        const { status, body } = await read(
          await webPost('/web/api/file', {
            action: 'readManaged',
            filePath: workbookPath
          })
        )

        expect(status).toBe(200)
        expect(body).toEqual({ data: [80, 75, 3, 4] })
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true })
      }
    })

    it('serves managed files through an authenticated browser resource URL', async () => {
      const filesRoot = await mkdtemp(join(tmpdir(), 'cherry-web-resource-'))
      const imagePath = join(filesRoot, 'image.png')
      const imageBytes = new Uint8Array([137, 80, 78, 71])
      await writeFile(imagePath, imageBytes)
      vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) => {
        const root = key === 'feature.files.data' ? filesRoot : `/mock/${key}`
        return filename ? join(root, filename) : root
      })

      try {
        const resourcePath = `/web/api/file-content?path=${encodeURIComponent(imagePath)}`
        const unauthorized = await get(app, resourcePath, {})
        const response = await get(app, resourcePath, { cookie })
        const outside = await get(app, `/web/api/file-content?path=${encodeURIComponent('/etc/passwd')}`, { cookie })

        expect(unauthorized.status).toBe(401)
        expect(response.status).toBe(200)
        expect(outside.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes)
      } finally {
        vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) =>
          filename ? `/mock/${key}/${filename}` : `/mock/${key}`
        )
        await rm(filesRoot, { recursive: true, force: true })
      }
    })

    it('serves bundled data resources without exposing other application resources', async () => {
      const resourcesRoot = await mkdtemp(join(tmpdir(), 'cherry-web-resources-'))
      const dataRoot = join(resourcesRoot, 'data')
      const imagePath = join(dataRoot, 'painting-templates', 'preview.webp')
      const privatePath = join(resourcesRoot, 'private.txt')
      await mkdir(dirname(imagePath), { recursive: true })
      await writeFile(imagePath, new Uint8Array([82, 73, 70, 70]))
      await writeFile(privatePath, 'private')
      vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) => {
        const root = key === 'app.extra_resources' ? resourcesRoot : `/mock/${key}`
        return filename ? join(root, filename) : root
      })

      try {
        const response = await get(app, `/web/api/file-content?path=${encodeURIComponent(imagePath)}`, { cookie })
        const readResponse = await read(
          await webPost('/web/api/file', {
            action: 'readManaged',
            filePath: imagePath
          })
        )
        const outside = await get(app, `/web/api/file-content?path=${encodeURIComponent(privatePath)}`, { cookie })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/webp')
        expect(readResponse).toEqual({ status: 200, body: { data: [82, 73, 70, 70] } })
        expect(outside.status).toBe(500)
      } finally {
        vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) =>
          filename ? `/mock/${key}/${filename}` : `/mock/${key}`
        )
        await rm(resourcesRoot, { recursive: true, force: true })
      }
    })

    it('serves relative HTML preview resources within the managed file root', async () => {
      const filesRoot = await mkdtemp(join(tmpdir(), 'cherry-web-html-resource-'))
      const htmlPath = join(filesRoot, 'preview', 'index.html')
      const imagePath = join(filesRoot, 'preview', 'images', 'cover.png')
      await mkdir(dirname(imagePath), { recursive: true })
      await writeFile(htmlPath, '<img src="images/cover.png">')
      await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]))
      vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) => {
        const root = key === 'feature.files.data' ? filesRoot : `/mock/${key}`
        return filename ? join(root, filename) : root
      })

      try {
        const token = Buffer.from(htmlPath).toString('base64url')
        const response = await get(app, `/web/api/file-content-tree/${token}/images/cover.png`, { cookie })
        const unauthorized = await get(app, `/web/api/file-content-tree/${token}/images/cover.png`, {})

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(unauthorized.status).toBe(401)
      } finally {
        vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) =>
          filename ? `/mock/${key}/${filename}` : `/mock/${key}`
        )
        await rm(filesRoot, { recursive: true, force: true })
      }
    })
  })

  describe('OpenAPI docs — per-language translation + switcher', () => {
    it('GET /openapi/json (no ?lang=) translates against the app language', async () => {
      const { status, body } = await read(await get(app, '/openapi/json', {}))
      expect(status).toBe(200)
      expect(body.info.description).toBe('apiGateway.docs.description::en-US')
      const health = body.paths['/health'].get
      expect(health.tags).toEqual(['Cherry Studio'])
      expect(health.summary).toBe('Health')
      expect(health.description).toBe('apiGateway.docs.operations.health::en-US')
    })

    it('groups endpoints by the upstream API they are compatible with, keeping canonical names', async () => {
      const { body } = await read(await get(app, '/openapi/json', {}))
      expect(body.tags.map((tag: { name: string }) => tag.name)).toEqual([
        'OpenAI API',
        'Anthropic API',
        'Gemini API',
        'Cherry Studio'
      ])
      // Tag names and operation summaries are upstream identifiers: never translated,
      // so generated clients keep stable module/method names. Only prose is localized.
      expect(body.tags[0].description).toBe('apiGateway.docs.tags.openai::en-US')
      expect(body.paths['/v1/chat/completions'].post.tags).toEqual(['OpenAI API'])
      expect(body.paths['/v1/chat/completions'].post.summary).toBe('Chat Completions')
      expect(body.paths['/v1/messages/'].post.tags).toEqual(['Anthropic API'])
      expect(body.paths['/v1/messages/'].post.summary).toBe('Messages')
    })

    it('routes every documented operation through translation (no raw i18n key survives)', async () => {
      const { body } = await read(await get(app, '/openapi/json?lang=zh-CN', {}))
      const operations = Object.values<any>(body.paths).flatMap((pathItem) => Object.values<any>(pathItem))
      expect(operations.length).toBeGreaterThan(0)
      for (const operation of operations) {
        // The stubbed `t()` appends `::lang`; a description a route declared but
        // openapiDocs.ts never resolved would show up here as a bare key.
        expect(operation.description).toMatch(/^apiGateway\.docs\.operations\.[a-z_]+::zh-CN$/)
      }
    })

    it('keeps the docs routes themselves out of the spec', async () => {
      const { body } = await read(await get(app, '/openapi/json', {}))
      expect(Object.keys(body.paths)).not.toContain('/openapi')
      expect(Object.keys(body.paths)).not.toContain('/openapi/json')
    })

    it('GET /openapi/json?lang=zh-CN translates against the requested language', async () => {
      const { body } = await read(await get(app, '/openapi/json?lang=zh-CN', {}))
      expect(body.info.description).toBe('apiGateway.docs.description::zh-CN')
      expect(body.paths['/health'].get.description).toBe('apiGateway.docs.operations.health::zh-CN')
    })

    it('GET /openapi/json?lang=not-a-real-language falls back to the app language', async () => {
      const { body } = await read(await get(app, '/openapi/json?lang=not-a-real-language', {}))
      expect(body.info.description).toBe('apiGateway.docs.description::en-US')
    })

    it('GET /openapi renders the description through t() (not a raw key) and points Scalar at the translated spec', async () => {
      const res = await get(app, '/openapi', {})
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      // The mocked `t()` embeds `::lang` on every call — the plain (untranslated) key never
      // appears without it, so this proves the <meta description> went through translation.
      expect(html).toContain('apiGateway.docs.description::en-US')
      expect(html).not.toContain('apiGateway.docs.description"')

      const configMatch = html.match(/data-configuration='(.+?)'/)
      expect(configMatch).toBeTruthy()
      const config = JSON.parse(configMatch![1])
      expect(config.url).toBe('http://localhost/openapi/json?lang=en-US')
      expect(config.localization).toEqual({ locale: 'en' })
    })

    it('pins the Scalar bundle and turns off its third-party "Ask AI" agent', async () => {
      const html = await (await get(app, '/openapi', {})).text()
      const config = JSON.parse(html.match(/data-configuration='(.+?)'/)![1])
      // Unpinned, an upstream release can change defaults (1.63.0 enabled Ask AI on
      // localhost) or break the toolbar the language switcher is inserted into.
      expect(config.cdn).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//)
      expect(config.version).toMatch(/^\d+\.\d+\.\d+$/)
      // Ask AI uploads the OpenAPI document to api.scalar.com — off unless a user
      // has been asked to accept that.
      expect(config.agent).toEqual({ disabled: true })
    })

    it('GET /openapi renders a language dropdown offering every supported language, defaulting to the app language', async () => {
      const html = await (await get(app, '/openapi', {})).text()
      expect(html).toContain(`<option value="en-US" selected>English</option>`)
      expect(html).toContain(`<option value="zh-CN">中文</option>`)
    })

    it('GET /openapi?lang=zh-CN renders Scalar chrome + the dropdown in the requested language', async () => {
      const html = await (await get(app, '/openapi?lang=zh-CN', {})).text()
      const config = JSON.parse(html.match(/data-configuration='(.+?)'/)![1])
      expect(config.url).toBe('http://localhost/openapi/json?lang=zh-CN')
      expect(config.localization).toEqual({ locale: 'zh-CN' })
      expect(html).toContain(`<option value="zh-CN" selected>中文</option>`)
    })
  })

  describe('auth', () => {
    it('rejects unauthenticated /v1 requests with 401', async () => {
      const { status, body } = await read(await get(app, '/v1/models', {}))
      expect(status).toBe(401)
      expect(body.error).toMatch(/Unauthorized/)
    })

    it('authenticates a /v1 request via the Authorization: Bearer header (@elysia/bearer)', async () => {
      const { status } = await read(await get(app, '/v1/models', { authorization: 'Bearer test-key' }))
      expect(status).toBe(200)
    })

    it('rejects a /v1 request with an invalid Bearer token (403)', async () => {
      const { status } = await read(await get(app, '/v1/models', { authorization: 'Bearer wrong-key' }))
      expect(status).toBe(403)
    })
  })

  describe('not found', () => {
    it('unmatched route → 404 Cherry REST envelope (does not crash onError)', async () => {
      const { status, body } = await read(await get(app, '/no-such-route', {}))
      expect(status).toBe(404)
      // App-level fallback uses the Cherry REST dialect: { error: { code, message } }.
      expect(body.error.code).toBe('NOT_FOUND')
      expect(body.error.type).toBeUndefined()
    })
  })

  describe("Cherry endpoints use Cherry's own REST error envelope", () => {
    it('knowledge search missing `query` → 422 REST envelope (not OpenAI dialect)', async () => {
      const { status, body } = await read(await post(app, '/v1/knowledge-bases/search', {}))
      expect(status).toBe(422)
      // REST dialect: { error: { code, message } } — no OpenAI `type`, no Anthropic top-level `type`.
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.type).toBeUndefined()
      expect(body.type).toBeUndefined()
    })
  })

  describe('validation → dialect-specific error envelopes', () => {
    it('chat completion missing `model` → OpenAI 400 envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(400)
      // OpenAI dialect: { error: { type, code } }, no top-level `type: 'error'`.
      expect(body.type).toBeUndefined()
      expect(body.error.type).toBe('invalid_request_error')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('responses missing `input` → OpenAI 400 envelope', async () => {
      const { status, body } = await read(await post(app, '/v1/responses', { model: 'openai:gpt-4' }))
      expect(status).toBe(400)
      expect(body.error.type).toBe('invalid_request_error')
    })

    it('messages missing `messages` → Anthropic 400 envelope', async () => {
      const { status, body } = await read(await post(app, '/v1/messages', { model: 'anthropic:claude' }))
      expect(status).toBe(400)
      // Anthropic dialect: { type: 'error', error: { type, message } }.
      expect(body.type).toBe('error')
      expect(body.error.type).toBe('invalid_request_error')
    })
  })

  describe('valid requests reach the handler', () => {
    it('valid chat completion passes validation and calls processMessage', async () => {
      const { status, body } = await read(
        await post(app, '/v1/chat/completions', { model: 'openai:gpt-4', messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(mockProcessMessage).toHaveBeenCalledOnce()
    })

    it('ignores the internal Fast header from a public API-key client', async () => {
      await read(
        await post(
          app,
          '/v1/messages',
          { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] },
          { ...AUTH, 'x-cherry-fast-mode': 'true' }
        )
      )

      expect(mockProcessMessage).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: false }))
    })

    it('accepts Fast only with the process-local internal request token', async () => {
      await read(
        await post(
          app,
          '/v1/messages',
          { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] },
          {
            ...AUTH,
            'x-cherry-fast-mode': 'true',
            'x-cherry-internal-request-token': 'internal-request-token'
          }
        )
      )

      expect(mockProcessMessage).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: true }))
    })

    it('GET /v1/models returns the model list', async () => {
      const { status, body } = await read(await get(app, '/v1/models'))
      expect(status).toBe(200)
      expect(body.object).toBe('list')
      expect(body.data).toHaveLength(1)
    })
  })

  describe('thrown provider errors → dialect status mapping (not a flat 500)', () => {
    const chat = { model: 'openai:gpt-4', messages: [{ role: 'user', content: 'hi' }] }

    it('chat: a 429 SerializedError → OpenAI 429 envelope, message preserved, extras dropped', async () => {
      mockProcessMessage.mockRejectedValueOnce({
        name: 'AI_APICallError',
        message: 'rate limited',
        stack: 'secret stack',
        statusCode: 429,
        url: 'https://provider/v1',
        requestBodyValues: { prompt: 'SECRET PROMPT' },
        responseBody: 'secret body'
      })
      const { status, body } = await read(await post(app, '/v1/chat/completions', chat))
      expect(status).toBe(429)
      expect(body.error.type).toBe('rate_limit_error')
      expect(body.error.message).toBe('rate limited')
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('secret stack')
      expect(serialized).not.toContain('SECRET PROMPT')
      expect(serialized).not.toContain('secret body')
      expect(serialized).not.toContain('https://provider/v1')
    })

    it('chat: a 403 SerializedError → OpenAI 403 forbidden envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({ name: 'Error', message: 'no access', stack: null, statusCode: 403 })
      const { status, body } = await read(await post(app, '/v1/chat/completions', chat))
      expect(status).toBe(403)
      expect(body.error.type).toBe('forbidden_error')
    })

    it('messages: a 401 SerializedError → Anthropic 401 authentication envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({ name: 'Error', message: 'bad key', stack: null, statusCode: 401 })
      const { status, body } = await read(
        await post(app, '/v1/messages', { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(401)
      expect(body.type).toBe('error') // Anthropic envelope
      expect(body.error.type).toBe('authentication_error')
      expect(body.error.message).toBe('bad key')
    })

    it('messages: a non-retryable provider 400 → Anthropic 400 invalid-request envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({
        name: 'AI_APICallError',
        message: 'Maximum context length exceeded',
        stack: null,
        statusCode: 400,
        isRetryable: false
      })
      const { status, body } = await read(
        await post(app, '/v1/messages', { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(400)
      expect(body.type).toBe('error')
      expect(body.error.type).toBe('invalid_request_error')
      expect(body.error.message).toBe('Maximum context length exceeded')
    })

    it('responses: an internal error with no status → 500 with the message gated out', async () => {
      mockProcessMessage.mockRejectedValueOnce(new Error('internal detail leak'))
      const { status, body } = await read(await post(app, '/v1/responses', { model: 'openai:gpt-4', input: 'hi' }))
      expect(status).toBe(500)
      expect(body.error.type).toBe('server_error')
      // NODE_ENV !== 'development' under test → internal messages are not leaked.
      expect(body.error.message).toBe('Internal server error')
    })
  })

  describe('Gemini (/v1beta) routes', () => {
    const geminiBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    const GOOG_AUTH = { 'content-type': 'application/json', 'x-goog-api-key': 'test-key' }

    it('generateContent: model + non-streaming derived from the URL, routed with gemini formats', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody)
      )
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(mockProcessMessage).toHaveBeenCalledOnce()
      expect(mockProcessMessage.mock.calls[0][0]).toMatchObject({
        modelString: 'deepseek:deepseek-chat',
        streaming: false,
        inputFormat: 'gemini',
        outputFormat: 'gemini'
      })
    })

    it('streamGenerateContent: preserves a slashed apiModelId and sets streaming=true', async () => {
      // The gateway model addressing "providerId:apiModelId" can contain both a
      // colon and a slash (aggregator ids like `agent/deepseek-v4-flash`); the
      // wildcard route must keep the whole model intact and split off only the method.
      await read(await post(app, '/v1beta/models/618d8838:agent/deepseek-v4-flash:streamGenerateContent', geminiBody))
      expect(mockProcessMessage.mock.calls[0][0]).toMatchObject({
        modelString: '618d8838:agent/deepseek-v4-flash',
        streaming: true,
        inputFormat: 'gemini'
      })
    })

    it('strips the gemini-cli sentinel suffix off the model before routing', async () => {
      // Cherry hands gemini-cli the address with an `@cherry` suffix so its model
      // normalization can't rewrite names ending in "flash"; the route must strip it.
      await read(
        await post(app, '/v1beta/models/618d8838:agent/deepseek-v4-flash@cherry:streamGenerateContent', geminiBody)
      )
      expect(mockProcessMessage.mock.calls[0][0]).toMatchObject({
        modelString: '618d8838:agent/deepseek-v4-flash',
        streaming: true
      })
    })

    it('rejects a model still ending in the reserved @cherry suffix after one strip → 400', async () => {
      // The sentinel is reserved: the route strips exactly one trailing `@cherry`, so a model that
      // STILL ends in it (a real id ending in the reserved marker, or a doubled sentinel) is
      // ambiguous and never advertised by GET /models — reject rather than route to the wrong id.
      const { status, body } = await read(
        await post(app, '/v1beta/models/weird:model@cherry@cherry:generateContent', geminiBody)
      )
      expect(status).toBe(400)
      expect(body.error.status).toBe('INVALID_ARGUMENT')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('countTokens: returns a local estimate without calling processMessage', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:countTokens', geminiBody)
      )
      expect(status).toBe(200)
      expect(typeof body.totalTokens).toBe('number')
      expect(body.totalTokens).toBeGreaterThan(0)
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    // Media is now counted (converted → shared walker, or the provider's remote count) rather
    // than rejected — the estimate reflects what the provider actually receives.
    it.each([
      ['inlineData', { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
      ['fileData', { fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/f.pdf' } }]
    ])('countTokens with %s media → 200 with a token estimate', async (_kind, mediaPart) => {
      const mediaBody = { contents: [{ role: 'user', parts: [mediaPart] }] }
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:countTokens', mediaBody)
      )
      expect(status).toBe(200)
      expect(typeof body.totalTokens).toBe('number')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('unsupported method → 400 Google INVALID_ARGUMENT envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:embedContent', geminiBody)
      )
      expect(status).toBe(400)
      expect(body.error.status).toBe('INVALID_ARGUMENT')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('rejects unauthenticated /v1beta requests with a 401 Google UNAUTHENTICATED envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody, {
          'content-type': 'application/json'
        })
      )
      expect(status).toBe(401)
      // Auth short-circuits before the handler, but must still speak the Google dialect.
      expect(body.error.code).toBe(401)
      expect(body.error.status).toBe('UNAUTHENTICATED')
      expect(typeof body.error.message).toBe('string')
      // Not the OpenAI/Anthropic shapes.
      expect(body.type).toBeUndefined()
      expect(body.error.type).toBeUndefined()
    })

    it('rejects an invalid /v1beta key with a 403 Google PERMISSION_DENIED envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody, {
          'content-type': 'application/json',
          'x-goog-api-key': 'wrong-key'
        })
      )
      expect(status).toBe(403)
      expect(body.error.code).toBe(403)
      expect(body.error.status).toBe('PERMISSION_DENIED')
    })

    it('authenticates via the x-goog-api-key header', async () => {
      const { status } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody, GOOG_AUTH)
      )
      expect(status).toBe(200)
    })

    it('authenticates via the ?key= query param', async () => {
      const { status } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent?key=test-key', geminiBody, {
          'content-type': 'application/json'
        })
      )
      expect(status).toBe(200)
    })

    it('missing `contents` → 400 Google envelope (not OpenAI/Anthropic dialect)', async () => {
      const { status, body } = await read(await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', {}))
      expect(status).toBe(400)
      expect(body.error.status).toBe('INVALID_ARGUMENT')
      expect(body.error.code).toBe(400)
      // Not the OpenAI/Anthropic shapes.
      expect(body.type).toBeUndefined()
      expect(body.error.type).toBeUndefined()
    })

    it('a thrown 429 provider error → Google RESOURCE_EXHAUSTED envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({ name: 'Error', message: 'rate limited', stack: null, statusCode: 429 })
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody)
      )
      expect(status).toBe(429)
      expect(body.error.status).toBe('RESOURCE_EXHAUSTED')
      expect(body.error.message).toBe('rate limited')
    })
  })
})
