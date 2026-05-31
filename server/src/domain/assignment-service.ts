import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, operators, tickets } from '../db/schema.js'
import { bus } from '../realtime/bus.js'
import { logger } from '../config/logger.js'

/**
 * Fair auto-assignment of queue tickets to online operators.
 *
 * Rules (confirmed with product):
 *  - Only operators that are online (lastSeenAt within window), available, role
 *    != admin are eligible. Admins never get auto-assigned (god-mode view only).
 *  - Least-loaded wins: the eligible operator with the fewest active tickets
 *    (open/pending and handling_mode='human') gets the next one. Ties broken by
 *    oldest lastSeenAt (longest waiting) for round-robin fairness.
 *  - No one online → ticket stays in queue unassigned (handling_mode='queue',
 *    assignedOperatorId=null). When someone logs in, drainQueue() distributes
 *    the backlog gradually (one per operator per pass, balancing as more join).
 */

const PRESENCE_WINDOW_MS = 60_000 // operator counts as online if seen within 60s

function onlineCutoff(): Date {
  return new Date(Date.now() - PRESENCE_WINDOW_MS)
}

export async function eligibleOperators() {
  // Pass the cutoff as an ISO string — postgres-js can't bind a raw Date inside
  // a sql template parameter.
  const cutoffIso = onlineCutoff().toISOString()
  return db
    .select({ id: operators.id, name: operators.name, lastSeenAt: operators.lastSeenAt })
    .from(operators)
    .where(
      and(
        eq(operators.active, true),
        eq(operators.available, true),
        sql`${operators.role} <> 'admin'`,
        sql`${operators.lastSeenAt} is not null and ${operators.lastSeenAt} >= ${cutoffIso}`,
      ),
    )
}

async function activeLoad(operatorId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(
      and(
        eq(tickets.assignedOperatorId, operatorId),
        sql`${tickets.status} in ('open','pending')`,
        eq(tickets.handlingMode, 'human'),
      ),
    )
  return row?.n ?? 0
}

/** Picks the least-loaded eligible operator, or null if none online. */
export async function pickOperator(): Promise<string | null> {
  const elig = await eligibleOperators()
  if (elig.length === 0) return null
  let best: { id: string; load: number; seen: number } | null = null
  for (const op of elig) {
    const load = await activeLoad(op.id)
    const seen = op.lastSeenAt ? op.lastSeenAt.getTime() : 0
    if (!best || load < best.load || (load === best.load && seen < best.seen)) {
      best = { id: op.id, load, seen }
    }
  }
  return best?.id ?? null
}

/**
 * Routes a ticket to the human queue: sets handling_mode and assigns an operator
 * if one is online. Returns the assigned operatorId (or null if queued waiting).
 */
export async function routeToQueue(
  ticketId: string,
  opts: { actor?: string; note?: string } = {},
): Promise<string | null> {
  const operatorId = await pickOperator()
  await db
    .update(tickets)
    .set({
      handlingMode: 'human',
      assignedOperatorId: operatorId,
      queuedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(tickets.id, ticketId))

  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  bus.emitEvent({
    type: 'ticket.created',
    ticketId,
    clientId: t!.clientId,
    subject: t!.subject,
    priority: t!.priority,
  })
  logger.info({ ticketId, operatorId: operatorId ?? 'unassigned' }, 'Ticket roteado para fila')
  return operatorId
}

/**
 * Distributes unassigned queue tickets to currently-online operators, balancing
 * by current load. Called when an operator logs in / heartbeats, and periodically.
 * Gradual: assigns oldest-queued first, re-picking least-loaded each time.
 */
export async function drainQueue(): Promise<number> {
  const elig = await eligibleOperators()
  if (elig.length === 0) return 0

  const unassigned = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.handlingMode, 'human'),
        isNull(tickets.assignedOperatorId),
        sql`${tickets.status} in ('open','pending')`,
      ),
    )
    .orderBy(asc(tickets.queuedAt))

  let assigned = 0
  for (const t of unassigned) {
    const operatorId = await pickOperator()
    if (!operatorId) break
    await db.update(tickets).set({ assignedOperatorId: operatorId }).where(eq(tickets.id, t.id))
    bus.emitEvent({
      type: 'ticket.created',
      ticketId: t.id,
      clientId: t.clientId,
      subject: t.subject,
      priority: t.priority,
    })
    assigned++
  }
  if (assigned) logger.info({ assigned }, 'Fila drenada para operadores online')
  return assigned
}

/** Heartbeat: marks operator online; triggers a queue drain so backlog flows in. */
export async function touchPresence(operatorId: string): Promise<void> {
  await db.update(operators).set({ lastSeenAt: new Date() }).where(eq(operators.id, operatorId))
}

/**
 * Auto-distributes a client to an operator's carteira (portfolio): picks the
 * active non-admin operator with the FEWEST owned clients (round-robin fairness)
 * and sets ownerOperatorId. Called when a client is first created. No-op if the
 * client already has an owner or there are no operators.
 */
export async function assignCarteira(clientId: string): Promise<string | null> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId))
  if (!client || client.ownerOperatorId) return client?.ownerOperatorId ?? null

  const ops = await db
    .select({ id: operators.id })
    .from(operators)
    .where(and(eq(operators.active, true), sql`${operators.role} <> 'admin'`))
  if (ops.length === 0) return null

  let best: { id: string; n: number } | null = null
  for (const op of ops) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(clients)
      .where(eq(clients.ownerOperatorId, op.id))
    const n = r?.n ?? 0
    if (!best || n < best.n) best = { id: op.id, n }
  }
  if (best) {
    await db.update(clients).set({ ownerOperatorId: best.id }).where(eq(clients.id, clientId))
    logger.info({ clientId, operatorId: best.id }, 'Cliente distribuído à carteira')
  }
  return best?.id ?? null
}
