import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock, getTraceDataMock } = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  getTraceDataMock: vi.fn()
}))

vi.mock('@application', () => ({ application: { get: appGetMock } }))

import { traceHandlers } from '../trace'

describe('traceHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appGetMock.mockReturnValue({ getTraceData: getTraceDataMock })
  })

  it('delegates trace reads with the polling cursor', async () => {
    const topicId = '123e4567-e89b-42d3-a456-426614174000'
    const cursor = { historyVersion: '1:100', liveRevision: 4 }
    const result = { cursor, reset: false, spans: [] }
    getTraceDataMock.mockResolvedValue(result)

    await expect(
      traceHandlers['trace.get_data']({ topicId, traceId: 'a'.repeat(32), cursor }, { senderId: null })
    ).resolves.toBe(result)
    expect(getTraceDataMock).toHaveBeenCalledWith(topicId, 'a'.repeat(32), cursor)
  })
})
