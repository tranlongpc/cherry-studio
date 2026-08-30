import { application } from '@application'
import type { traceRequestSchemas } from '@shared/ipc/schemas/trace'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const traceHandlers: IpcHandlersFor<typeof traceRequestSchemas> = {
  'trace.get_data': async ({ topicId, traceId, cursor }) =>
    application.get('TraceStorageService').getTraceData(topicId, traceId, cursor)
}
