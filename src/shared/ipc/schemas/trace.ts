import { TopicIdSchema } from '@shared/data/types/topic'
import type { TraceDataResult } from '@shared/data/types/trace'
import { TraceIdSchema } from '@shared/data/types/trace'
import * as z from 'zod'

import { defineRoute } from '../define'

const traceDataCursorSchema = z.strictObject({
  historyVersion: z.string().nullable(),
  liveRevision: z.number().int().nonnegative()
})

export const traceRequestSchemas = {
  'trace.get_data': defineRoute({
    input: z.strictObject({
      topicId: TopicIdSchema,
      traceId: TraceIdSchema,
      cursor: traceDataCursorSchema.optional()
    }),
    output: z.custom<TraceDataResult>()
  })
}
