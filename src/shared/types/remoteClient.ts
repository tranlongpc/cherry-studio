export const REMOTE_CLIENT_HEADER = 'x-cherry-remote-client'
export const REMOTE_CLIENT_COOKIE = 'cherry_web_session'

export type RemoteClientConnectionErrorKind = 'authentication' | 'invalid-url' | 'network' | 'server'

export interface RemoteClientConnectionInput {
  serverUrl: string
  email: string
  password: string
}

export interface RemoteClientSessionInput {
  serverUrl: string
  token: string
}

export type RemoteClientConnectionResult =
  | { success: true; session: RemoteClientSessionInput }
  | { success: false; error: RemoteClientConnectionErrorKind }
