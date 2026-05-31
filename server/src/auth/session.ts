import { sha256 } from '@oslojs/crypto/sha2'
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { operators, sessions, type Operator, type Session } from '../db/schema.js'

/**
 * Self-hosted session auth following the (now canonical) Lucia pattern:
 * https://lucia-auth.com/sessions/basic
 *
 * The raw token is sent to the client (cookie); only its SHA-256 hash is the
 * primary key in the DB, so a DB leak can't be used to hijack sessions.
 */
const DAY = 1000 * 60 * 60 * 24
const SESSION_TTL = DAY * 30
const RENEW_THRESHOLD = DAY * 15

export const SESSION_COOKIE = 'alelo_session'

export type SafeOperator = Omit<Operator, 'passwordHash'>

export interface SessionValidationResult {
  session: Session
  operator: SafeOperator
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return encodeBase32LowerCaseNoPadding(bytes)
}

function tokenToId(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)))
}

export async function createSession(token: string, operatorId: string): Promise<Session> {
  const id = tokenToId(token)
  const session: Session = {
    id,
    operatorId,
    expiresAt: new Date(Date.now() + SESSION_TTL),
  }
  await db.insert(sessions).values(session)
  return session
}

export async function validateSessionToken(token: string): Promise<SessionValidationResult | null> {
  const id = tokenToId(token)
  const [row] = await db
    .select({ session: sessions, operator: operators })
    .from(sessions)
    .innerJoin(operators, eq(sessions.operatorId, operators.id))
    .where(eq(sessions.id, id))
  if (!row) return null

  const { session, operator } = row

  // Expired -> drop it.
  if (Date.now() >= session.expiresAt.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return null
  }
  // Disabled operator -> kill session.
  if (!operator.active) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return null
  }

  // Sliding expiration: extend when inside the renewal window.
  if (Date.now() >= session.expiresAt.getTime() - RENEW_THRESHOLD) {
    session.expiresAt = new Date(Date.now() + SESSION_TTL)
    await db.update(sessions).set({ expiresAt: session.expiresAt }).where(eq(sessions.id, id))
  }

  const { passwordHash: _omit, ...safe } = operator
  return { session, operator: safe }
}

export async function invalidateSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenToId(token)))
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    expires: expiresAt,
  }
}
