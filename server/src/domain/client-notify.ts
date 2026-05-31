import { desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, conversations, messages } from '../db/schema.js'
import { bus } from '../realtime/bus.js'
import { sendImage as gwImage, sendText as gwText, isReady as gwReady } from '../whatsapp/outbound.js'
import { markDelivered } from './outbox.js'

/**
 * Proactive bot → client messaging that ALSO lands in the operator UI.
 *
 * Raw outbound.sendText/sendImage only hit WhatsApp; messages sent by the
 * scheduler/webhook/tools never appeared in the panel thread. notifyText/Image
 * persist a 'bot' message on the client's latest conversation and emit the
 * realtime event, so the UI shows exactly what the client received.
 */

async function latestConversationId(clientId: string): Promise<string | null> {
  const [c] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.clientId, clientId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1)
  return c?.id ?? null
}

/**
 * Persist a bot message and return its id (or null). `deliveredNow` marks it
 * delivered immediately (used for image rows, which the outbox never resends).
 */
async function storeBot(
  conversationId: string,
  clientId: string,
  content: string,
  deliveredNow = false,
  image?: string,
): Promise<string | null> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      role: 'bot',
      content,
      deliveredAt: deliveredNow ? new Date() : null,
      metadata: image ? { image } : {},
    })
    .returning()
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(conversations.id, conversationId))
  bus.emitEvent({
    type: 'message',
    conversationId,
    clientId,
    role: 'bot',
    content,
    at: row?.createdAt?.toISOString() ?? new Date().toISOString(),
  })
  return row?.id ?? null
}

/**
 * Send a text to the client and record it on the conversation (UI-visible).
 * Persist-then-send: if WhatsApp is offline/the send fails, the row stays
 * pending and flushOutbox resends it on reconnect (UI ↔ WhatsApp sync).
 */
export async function notifyText(clientId: string, text: string): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId))
  if (!client) return
  const convId = await latestConversationId(clientId)
  const msgId = convId ? await storeBot(convId, clientId, text).catch(() => null) : null
  if (gwReady()) {
    await gwText(client.phone, text)
      .then(async () => {
        if (msgId) await markDelivered(msgId)
      })
      .catch(() => {}) // stays pending → outbox retries on reconnect
  }
}

/** Send an image (QR) + record a text line on the conversation (UI-visible). */
export async function notifyImage(clientId: string, base64: string, caption: string): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId))
  if (!client) return
  const convId = await latestConversationId(clientId)
  // deliveredNow=true: the outbox only resends text; replaying a caption alone
  // would drop the image, so we don't queue image rows. Store the QR as a data
  // URL in metadata so the operator panel can render it inline (UI parity).
  const dataUrl = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
  if (convId) await storeBot(convId, clientId, caption, true, dataUrl).catch(() => {})
  await gwImage(client.phone, base64, caption).catch(() => {})
}

// Sales pipeline order; advanceStage only moves a client forward, never back.
const STAGE_ORDER: Record<string, number> = { lead: 0, quoting: 1, signing: 2, active: 3 }

/** Move a client forward in the pipeline (lead → quoting → signing → active). */
export async function advanceStage(
  clientId: string,
  to: 'quoting' | 'signing' | 'active',
): Promise<void> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId))
  if (!c) return
  if ((STAGE_ORDER[to] ?? 0) > (STAGE_ORDER[c.stage] ?? 0)) {
    await db.update(clients).set({ stage: to, updatedAt: new Date() }).where(eq(clients.id, clientId))
  }
}
