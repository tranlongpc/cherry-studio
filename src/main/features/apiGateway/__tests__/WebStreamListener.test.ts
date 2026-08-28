import type { WebStreamEvent } from '@main/features/apiGateway/WebStreamListener'
import { describe, expect, it, vi } from 'vitest'

import { WebStreamListener } from '../WebStreamListener'

describe('WebStreamListener', () => {
  it('publishes pending execution identities before chunks arrive', () => {
    const emitCache = vi.fn()
    const listener = new WebStreamListener('web:client:topic-1', 'topic-1', vi.fn(), emitCache)

    listener.onStarted([{ executionId: 'provider::model', attemptId: 3, anchorMessageId: 'message-1' }])

    expect(emitCache).toHaveBeenCalledWith({
      type: 'shared',
      key: 'topic.stream.statuses.topic-1',
      value: {
        status: 'pending',
        activeExecutions: [{ executionId: 'provider::model', attemptId: 3, anchorMessageId: 'message-1' }],
        awaitingApprovalAnchors: []
      }
    })
  })

  it('projects stream chunks into the renderer event contract', () => {
    const emit = vi.fn<(event: WebStreamEvent) => void>()
    const emitCache = vi.fn()
    const listener = new WebStreamListener('web:client:topic-1', 'topic-1', emit, emitCache)

    listener.onChunk({ type: 'text-delta', id: 'text-1', delta: 'Hello' }, 'provider::model', 'message-1', 3)

    expect(emit).toHaveBeenCalledWith({
      event: 'ai.stream.chunk',
      payload: {
        topicId: 'topic-1',
        executionId: 'provider::model',
        attemptId: 3,
        anchorMessageId: 'message-1',
        chunk: { type: 'text-delta', id: 'text-1', delta: 'Hello' }
      }
    })
  })

  it('emits terminal events and remains available for the next turn', () => {
    const emit = vi.fn<(event: WebStreamEvent) => void>()
    const emitCache = vi.fn()
    const listener = new WebStreamListener('web:client:topic-1', 'topic-1', emit, emitCache)

    listener.onDone({ status: 'success', modelId: 'provider::model', isTopicDone: true })

    expect(emit).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith({
      event: 'ai.stream.done',
      payload: {
        topicId: 'topic-1',
        executionId: 'provider::model',
        status: 'success',
        isTopicDone: true
      }
    })
    expect(listener.isAlive()).toBe(true)
    expect(listener.persistAcrossTurns).toBe(true)
  })
})
