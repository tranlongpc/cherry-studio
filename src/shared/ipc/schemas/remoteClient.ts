import * as z from 'zod'

import type {
  RemoteClientConnectionInput,
  RemoteClientConnectionResult,
  RemoteClientSessionInput
} from '../../types/remoteClient'
import { defineRoute } from '../define'

const remoteClientConnectionInputSchema: z.ZodType<RemoteClientConnectionInput> = z.object({
  serverUrl: z.string().trim().min(1),
  email: z.string(),
  password: z.string()
})

const remoteClientSessionInputSchema: z.ZodType<RemoteClientSessionInput> = z.object({
  serverUrl: z.string(),
  token: z.string()
})

const remoteClientConnectionResultSchema: z.ZodType<RemoteClientConnectionResult> = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), session: remoteClientSessionInputSchema }),
  z.object({
    success: z.literal(false),
    error: z.enum(['authentication', 'invalid-url', 'network', 'server'])
  })
])

export const remoteClientRequestSchemas = {
  'remote_client.connect': defineRoute({
    input: remoteClientConnectionInputSchema,
    output: remoteClientConnectionResultSchema
  }),
  'remote_client.restore_session': defineRoute({
    input: z.void(),
    output: remoteClientSessionInputSchema.nullable()
  }),
  'remote_client.clear_session': defineRoute({
    input: z.void(),
    output: z.void()
  })
}

export type RemoteClientRequestSchemas = typeof remoteClientRequestSchemas
export type RemoteClientRoute = keyof RemoteClientRequestSchemas
export type RemoteClientInputFor<R extends RemoteClientRoute> = z.infer<RemoteClientRequestSchemas[R]['input']>
export type RemoteClientOutputFor<R extends RemoteClientRoute> = z.infer<RemoteClientRequestSchemas[R]['output']>
