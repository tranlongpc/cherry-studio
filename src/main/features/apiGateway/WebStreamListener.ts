import type { StreamDoneResult, StreamErrorResult, StreamListener, StreamPausedResult } from '@main/ai/streamManager'
import { projectStreamChunkForRenderer } from '@main/utils/messageOutputProjection'
import type { ActiveExecution } from '@shared/ai/transport'
import type { CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type { UniqueModelId } from '@shared/data/types/model'
import type { IpcEventName } from '@shared/ipc/schemas/ipcSchemas'
import type { EventPayload } from '@shared/ipc/types'
import type { UIMessageChunk } from 'ai'

export type WebStreamEvent = {
  [E in IpcEventName]: { event: E; payload: EventPayload<E> }
}[IpcEventName]

export class WebStreamListener implements StreamListener {
  readonly persistAcrossTurns = true
  private alive = true

  constructor(
    readonly id: string,
    private readonly topicId: string,
    private readonly emit: (event: WebStreamEvent) => void,
    private readonly emitCache: (message: CacheSyncMessage) => void
  ) {}

  onStarted(activeExecutions: ActiveExecution[]): void {
    this.emitCache({
      type: 'shared',
      key: `topic.stream.statuses.${this.topicId}`,
      value: { status: 'pending', activeExecutions, awaitingApprovalAnchors: [] }
    })
  }

  onChunk(chunk: UIMessageChunk, sourceModelId?: UniqueModelId, anchorMessageId?: string, attemptId?: number): void {
    this.send('ai.stream.chunk', {
      topicId: this.topicId,
      executionId: sourceModelId,
      ...(attemptId !== undefined ? { attemptId } : {}),
      anchorMessageId,
      chunk: projectStreamChunkForRenderer(chunk, this.topicId, anchorMessageId)
    })
  }

  onDone(result: StreamDoneResult): void {
    this.sendTerminal(result)
  }

  onPaused(result: StreamPausedResult): void {
    this.sendTerminal(result)
  }

  onError(result: StreamErrorResult): void {
    this.send('ai.stream.error', {
      topicId: this.topicId,
      executionId: result.modelId,
      ...(result.attemptId !== undefined ? { attemptId: result.attemptId } : {}),
      ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
      anchorMessageId: result.anchorMessageId,
      isTopicDone: result.isTopicDone,
      error: result.error
    })
  }

  isAlive(): boolean {
    return this.alive
  }

  close(): void {
    this.alive = false
  }

  private sendTerminal(result: StreamDoneResult | StreamPausedResult): void {
    this.send('ai.stream.done', {
      topicId: this.topicId,
      executionId: result.modelId,
      ...(result.attemptId !== undefined ? { attemptId: result.attemptId } : {}),
      ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
      anchorMessageId: result.anchorMessageId,
      status: result.status,
      isTopicDone: result.isTopicDone
    })
  }

  private send<E extends IpcEventName>(event: E, payload: EventPayload<E>): void {
    if (this.alive) this.emit({ event, payload } as WebStreamEvent)
  }
}
