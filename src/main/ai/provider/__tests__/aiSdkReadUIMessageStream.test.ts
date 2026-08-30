import { readUIMessageStream, type UIMessageChunk } from 'ai'
import { describe, expect, it } from 'vitest'

describe('AI SDK UI message stream cleanup', () => {
  it('does not reject when the consumer cancels before the source finishes', async () => {
    let source!: ReadableStreamDefaultController<UIMessageChunk>
    const input = new ReadableStream<UIMessageChunk>({
      start(controller) {
        source = controller
      }
    })
    const output = readUIMessageStream({ stream: input })
    const failures: unknown[] = []
    const handleUnhandledRejection = (error: unknown) => failures.push(error)

    process.on('unhandledRejection', handleUnhandledRejection)
    try {
      source.enqueue({ type: 'text-start', id: 'text-1' })
      const reader = output.getReader()
      await reader.read()
      await reader.cancel()
      source.enqueue({ type: 'text-delta', id: 'text-1', delta: 'next' })
      source.close()
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', handleUnhandledRejection)
    }

    expect(failures).toEqual([])
  })
})
