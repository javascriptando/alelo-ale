import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { operators } from '../db/schema.js'
import { verifyPassword } from './password.js'
import {
  SESSION_COOKIE,
  createSession,
  generateSessionToken,
  invalidateSession,
  sessionCookieOptions,
  validateSessionToken,
  type SafeOperator,
} from './session.js'
import { drainQueue, touchPresence } from '../domain/assignment-service.js'

declare module 'fastify' {
  interface FastifyRequest {
    operator?: SafeOperator
  }
}

/** preHandler that requires a valid session; 401 otherwise. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE]
  if (!token) return reply.code(401).send({ error: 'unauthenticated' })
  const result = await validateSessionToken(token)
  if (!result) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(401).send({ error: 'unauthenticated' })
  }
  req.operator = result.operator
  // Presence heartbeat: every authenticated request marks the operator online,
  // so auto-assignment knows who's available. Fire-and-forget.
  void touchPresence(result.operator.id).catch(() => {})
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body)

    const [op] = await db.select().from(operators).where(eq(operators.email, body.email))
    // Always run a verify to avoid leaking which emails exist (timing).
    const ok =
      op && op.active ? await verifyPassword(op.passwordHash, body.password).catch(() => false) : false
    if (!op || !ok) return reply.code(401).send({ error: 'credenciais inválidas' })

    const token = generateSessionToken()
    const session = await createSession(token, op.id)
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(session.expiresAt))
    // Mark online and pull any queued backlog toward the now-available operators.
    await touchPresence(op.id)
    void drainQueue().catch(() => {})
    return { id: op.id, name: op.name, email: op.email, role: op.role }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) await invalidateSession(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    return req.operator
  })
}
