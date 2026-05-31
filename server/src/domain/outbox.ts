import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, conversations, messages } from '../db/schema.js'
import { logger } from '../config/logger.js'
import type { WhatsAppGateway } from '../whatsapp/gateway.js'

/**
 * Outbound delivery guarantee. Every bot/operator message is persisted FIRST
 * (so it always shows in the UI), then sent over WhatsApp. If the send fails or
 * the number is offline, the row keeps `deliveredAt = null` and is retried by
 * `flushOutbox` the moment the connection is back — keeping the panel and
 * WhatsApp in sync without losing a single message.
 */

/** Mark a message as delivered (sent over WhatsApp) now. */
export async function markDelivered(messageId: string): Promise<void> {
  await db.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, messageId))
}

/**
 * Try to send an already-persisted text message and mark it delivered on
 * success. On failure it stays pending for the next flush. Never throws.
 */
export async function sendAndMark(
  gateway: WhatsAppGateway,
  messageId: string,
  phone: string,
  text: string,
): Promise<boolean> {
  if (!gateway.isReady()) return false
  try {
    await gateway.sendText(phone, text)
    await markDelivered(messageId)
    return true
  } catch (err) {
    logger.warn({ err: (err as Error).message, messageId }, 'Outbox: envio falhou; ficará pendente')
    return false
  }
}

let flushing = false

// Only RECENT pending messages are resent on reconnect. A message older than
// this was almost certainly already delivered (or is too stale to dump on the
// client now) — resending the whole day's history is exactly the "enviou tudo
// de novo" bug. 15 min covers a real reconnect gap without replaying history.
const RESEND_WINDOW_MS = 15 * 60 * 1000
// Grace period: never resend a message that was just created — the live send
// path (sendAndMark) needs a moment to confirm + mark it delivered. Without
// this, a flush tick racing the live send delivers the SAME message twice.
const RESEND_GRACE_MS = 45 * 1000

/**
 * Mark every currently-pending bot/operator message OLDER than the resend window
 * as delivered, so a one-off backfill (e.g. after adding the column) or a long
 * downtime never floods the client with old messages. Call once on boot.
 */
export async function reconcileOldPending(): Promise<void> {
  const cutoff = new Date(Date.now() - RESEND_WINDOW_MS)
  const res = await db
    .update(messages)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        inArray(messages.role, ['bot', 'operator']),
        isNull(messages.deliveredAt),
        sql`${messages.createdAt} < ${cutoff.toISOString()}`,
      ),
    )
    .returning({ id: messages.id })
  if (res.length) logger.info({ count: res.length }, 'Outbox: histórico antigo marcado como entregue (sem reenviar)')
}

/**
 * Resend pending bot/operator messages from the last RESEND_WINDOW_MS, oldest
 * first, preserving order. Called on (re)connect and on each scheduler tick
 * while connected. Concurrency-guarded so overlapping triggers don't double-send.
 */
export async function flushOutbox(gateway: WhatsAppGateway): Promise<number> {
  if (flushing || !gateway.isReady()) return 0
  flushing = true
  let sent = 0
  try {
    const since = new Date(Date.now() - RESEND_WINDOW_MS)
    const until = new Date(Date.now() - RESEND_GRACE_MS) // skip just-created rows
    const pending = await db
      .select({
        id: messages.id,
        content: messages.content,
        phone: clients.phone,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(clients, eq(conversations.clientId, clients.id))
      .where(
        and(
          inArray(messages.role, ['bot', 'operator']),
          isNull(messages.deliveredAt),
          gte(messages.createdAt, since),
          sql`${messages.createdAt} < ${until.toISOString()}`,
          sql`${messages.content} <> ''`,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(100)

    for (const m of pending) {
      if (!gateway.isReady()) break
      const ok = await sendAndMark(gateway, m.id, m.phone, m.content)
      if (ok) sent++
      else break // connection likely dropped again; stop, retry next time
    }
    if (sent) logger.info({ sent }, 'Outbox: mensagens pendentes reenviadas')
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Outbox: flush falhou')
  } finally {
    flushing = false
  }
  return sent
}
