import { readFile } from 'node:fs/promises'

import { application } from '@application'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})

import { loadWebAuthEnvironment } from '../webAuth'

const readFileMock = vi.mocked(readFile)

beforeEach(() => {
  readFileMock.mockReset()
  vi.stubEnv('CHERRY_WEB_EMAIL', '')
  vi.stubEnv('CHERRY_WEB_PASSWORD_HASH', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('loadWebAuthEnvironment', () => {
  it('loads web credentials from the registered application data file', async () => {
    readFileMock.mockResolvedValue('CHERRY_WEB_EMAIL=user@example.com\nCHERRY_WEB_PASSWORD_HASH=scrypt\\$salt\\$hash\n')

    await loadWebAuthEnvironment()

    expect(application.getPath).toHaveBeenCalledWith('feature.api_gateway.web_auth_file')
    expect(process.env.CHERRY_WEB_EMAIL).toBe('user@example.com')
    expect(process.env.CHERRY_WEB_PASSWORD_HASH).toBe('scrypt$salt$hash')
  })

  it('preserves credentials supplied by the launch environment', async () => {
    vi.stubEnv('CHERRY_WEB_EMAIL', 'launch@example.com')
    vi.stubEnv('CHERRY_WEB_PASSWORD_HASH', 'launch-hash')
    readFileMock.mockResolvedValue(
      'CHERRY_WEB_EMAIL=file@example.com\nCHERRY_WEB_PASSWORD_HASH=scrypt$salt$file-hash\n'
    )

    await loadWebAuthEnvironment()

    expect(process.env.CHERRY_WEB_EMAIL).toBe('launch@example.com')
    expect(process.env.CHERRY_WEB_PASSWORD_HASH).toBe('launch-hash')
  })
})
