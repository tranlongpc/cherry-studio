import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { application } from '@application'
import { loggerService } from '@logger'
import { parse } from 'dotenv'

const scrypt = promisify(scryptCallback)
const logger = loggerService.withContext('WebAuth')
const COOKIE_NAME = 'cherry_web_session'
const SESSION_TTL_SECONDS = 12 * 60 * 60
const sessions = new Map<string, number>()
const WEB_AUTH_ENV_KEYS = ['CHERRY_WEB_EMAIL', 'CHERRY_WEB_PASSWORD_HASH'] as const

export async function loadWebAuthEnvironment(): Promise<void> {
  let source: string
  try {
    source = await readFile(application.getPath('feature.api_gateway.web_auth_file'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('Failed to read web authentication environment', error as Error)
    }
    return
  }

  const values = parse(source)
  for (const key of WEB_AUTH_ENV_KEYS) {
    if (process.env[key] || !values[key]) continue
    process.env[key] = key === 'CHERRY_WEB_PASSWORD_HASH' ? values[key].replaceAll('\\$', '$') : values[key]
  }
}

function equal(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function configuredCredentials(): { email: string; passwordHash: string } | undefined {
  const email = process.env.CHERRY_WEB_EMAIL?.trim()
  const passwordHash = process.env.CHERRY_WEB_PASSWORD_HASH?.trim()
  return email && passwordHash ? { email, passwordHash } : undefined
}

async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = encodedHash.split('$')
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false
  const expected = Buffer.from(expectedHex, 'hex')
  if (expected.length !== 64 || expected.toString('hex') !== expectedHex.toLowerCase()) return false
  const actual = (await scrypt(password, salt, expected.length)) as Buffer
  return timingSafeEqual(actual, expected)
}

function sessionToken(request: Request): string | undefined {
  const cookie = request.headers.get('cookie')
  if (!cookie) return undefined
  for (const pair of cookie.split(';')) {
    const [name, ...value] = pair.trim().split('=')
    if (name === COOKIE_NAME) return value.join('=')
  }
  return undefined
}

function removeExpiredSessions(now = Date.now()): void {
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token)
  }
}

export function webAuthConfigured(): boolean {
  return configuredCredentials() !== undefined
}

export async function authenticateWebCredentials(email: string, password: string): Promise<string | undefined> {
  const credentials = configuredCredentials()
  if (!credentials) return undefined
  const emailMatches = equal(email.trim().toLowerCase(), credentials.email.toLowerCase())
  const passwordMatches = await verifyPassword(password, credentials.passwordHash)
  if (!emailMatches || !passwordMatches) return undefined
  removeExpiredSessions()
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, Date.now() + SESSION_TTL_SECONDS * 1000)
  return token
}

export function isWebSessionAuthenticated(request: Request): boolean {
  const token = sessionToken(request)
  if (!token) return false
  const expiresAt = sessions.get(token)
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token)
    return false
  }
  return true
}

export function webSessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/web/api; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`
}

export function clearWebSessions(): void {
  sessions.clear()
}
