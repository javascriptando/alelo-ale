import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, conversations, messages, npsResponses, tickets } from '../db/schema.js'
import { runAgentTurn } from '../ai/agent.js'
import { bus } from '../realtime/bus.js'
import { logger } from '../config/logger.js'
import {
  activeTicketForConversation,
  ensureTicket,
  latestTicket,
  markFirstResponse,
  maybeResumeOnInbound,
  transitionTicket,
} from './ticket-service.js'
import { assignCarteira } from './assignment-service.js'
import { sendAndMark } from './outbox.js'
import type { InboundMessage, WhatsAppGateway } from '../whatsapp/gateway.js'

const HISTORY_LIMIT = 20

async function getOrCreateClient(phone: string, pushName?: string) {
  const [existing] = await db.select().from(clients).where(eq(clients.phone, phone))
  if (existing) return existing
  const [created] = await db
    .insert(clients)
    .values({
      phone,
      companyName: pushName ? `${pushName} (a confirmar)` : `Empresa ${phone}`,
      contactName: pushName,
      stage: 'lead',
    })
    .returning()
  // Auto-distribui o novo cliente para a carteira de um operador (round-robin).
  if (created) await assignCarteira(created.id).catch(() => {})
  return created!
}

/**
 * One continuous conversation thread PER CLIENT. The conversation is the
 * permanent timeline; *tickets* are what open/close to segment it. So when a
 * client writes again after a finalized ticket, we REUSE the same conversation
 * (reactivating it) instead of spawning a duplicate conversation row — a fresh
 * ticket is created inside it (see ensureTicket). This keeps history continuous
 * and avoids the "conversa duplicada" the operator saw in the inbox.
 */
async function getOrCreateConversation(clientId: string) {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.clientId, clientId))
    .orderBy(desc(conversations.lastMessageAt))
  if (existing) {
    // A closed conversation gets reactivated to 'bot' (AI handles the new
    // request); a new ticket will segment it. Same thread, no duplicate.
    if (existing.status === 'closed') {
      await db.update(conversations).set({ status: 'bot' }).where(eq(conversations.id, existing.id))
      return { ...existing, status: 'bot' as const }
    }
    return existing
  }
  const [created] = await db
    .insert(conversations)
    .values({ clientId, status: 'bot' })
    .returning()
  return created!
}

// Cap how much of each past message goes back into the model's context. Giant
// blobs (a raw DocuSign URL ~1.8k chars, a pasted employee list ~9k chars) don't
// help the model decide the next step — they just bloat every subsequent call,
// making replies SLOW and incoherent (the "loop / coisas sem sentido" report).
// We keep a short, meaningful summary marker instead of the full payload.
const HISTORY_CHARS_PER_MSG = 600

function condenseForHistory(content: string): string {
  const text = content ?? ''
  if (text.length <= HISTORY_CHARS_PER_MSG) return text
  // Long signing link → don't replay the token; the model only needs to know it
  // was sent.
  if (/docusign\.net|\/Signing\/|slt=/.test(text)) {
    return '[link de assinatura do contrato enviado ao cliente]'
  }
  // Long pasted list (employees / CSV) → keep the head + a count hint.
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length > 8) {
    return `${lines.slice(0, 4).join('\n')}\n…[+${lines.length - 4} linhas — lista recebida]`
  }
  return text.slice(0, HISTORY_CHARS_PER_MSG) + '…'
}

async function loadHistory(conversationId: string): Promise<ChatCompletionMessageParam[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT)
  rows.reverse()
  return rows.map((m): ChatCompletionMessageParam => {
    const content = condenseForHistory(m.content)
    if (m.role === 'client') return { role: 'user', content }
    return { role: 'assistant', content }
  })
}

async function storeMessage(
  conversationId: string,
  clientId: string,
  role: 'client' | 'bot' | 'operator' | 'system',
  content: string,
  extra: { waMessageId?: string; toolName?: string; ticketId?: string } = {},
) {
  // Race safety net: if two deliveries slip past the pre-check, the partial
  // unique index on wa_message_id rejects the second. We use onConflictDoNothing
  // WITHOUT a target — specifying a partial-index target errors in Postgres
  // ("no unique constraint matching"). No target = do nothing on any conflict,
  // which here can only be the wa id index. Bot/operator rows (null wa id)
  // never conflict.
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      content,
      waMessageId: extra.waMessageId,
      toolName: extra.toolName,
      ticketId: extra.ticketId,
      // Inbound (client) + system messages are "delivered" on arrival. Bot/
      // operator rows stay pending until confirmed sent (see sendAndMark/outbox).
      deliveredAt: role === 'client' || role === 'system' ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning()
  if (!row) return null // duplicate inbound — nothing stored, don't emit/reply

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(conversations.id, conversationId))
  bus.emitEvent({
    type: 'message',
    conversationId,
    clientId,
    role,
    content,
    at: row.createdAt?.toISOString() ?? new Date().toISOString(),
  })
  return row
}

/**
 * If an NPS survey is pending for this client (sent, not yet answered) and the
 * message carries a 0–10 score, persist the score, resolve the related ticket,
 * thank the client and return true (handled). Otherwise return false.
 *
 * This is what actually ENDS an attendance: the survey is sent during the chat,
 * and the client's numeric reply is captured here — so the score is stored and
 * no duplicate "Atendimento iniciado" ticket is created for the reply.
 */
async function tryCaptureNps(
  clientId: string,
  text: string,
  gateway: WhatsAppGateway,
  phone: string,
  waMessageId?: string,
): Promise<boolean> {
  const [pending] = await db
    .select()
    .from(npsResponses)
    .where(eq(npsResponses.clientId, clientId))
    .orderBy(desc(npsResponses.sentAt))
    .limit(1)
  if (!pending || pending.answeredAt != null || pending.score != null) return false

  // Only treat as an answer if the message clearly contains a 0–10 number.
  const m = text.match(/\b(10|[0-9])\b/)
  if (!m) return false
  const score = Number(m[1])

  await db
    .update(npsResponses)
    .set({ score, answeredAt: new Date(), comment: text.slice(0, 280) })
    .where(eq(npsResponses.id, pending.id))

  // Resolve the ticket tied to the survey (or the client's latest active one).
  const ticket =
    (pending.ticketId
      ? (await db.select().from(tickets).where(eq(tickets.id, pending.ticketId)))[0]
      : undefined) ?? (await latestTicket(clientId))
  if (ticket && (ticket.status === 'open' || ticket.status === 'pending')) {
    await transitionTicket(ticket.id, 'resolved', {
      actor: 'ai',
      note: `NPS recebido: nota ${score}.`,
    }).catch(() => {})
  }

  // Persist BOTH the client's score reply and the thank-you so the panel history
  // is complete (it used to stop at the NPS question because this early-return
  // path skipped the normal storeMessage flow).
  const convo = await getOrCreateConversation(clientId)
  await storeMessage(convo.id, clientId, 'client', text, {
    waMessageId,
    ticketId: ticket?.id,
  })

  const thanks =
    score >= 9
      ? 'Que ótimo! 💚 Muito obrigada pela nota. Seguimos à disposição sempre que precisar.'
      : score >= 7
        ? 'Obrigada pela avaliação! 💚 Vamos seguir melhorando pra te atender ainda melhor.'
        : 'Obrigada pela sinceridade. 🙏 Sua nota nos ajuda a melhorar — qualquer coisa, é só chamar.'
  const stored = await storeMessage(convo.id, clientId, 'bot', thanks, { ticketId: ticket?.id })
  if (stored) await sendAndMark(gateway, stored.id, phone, thanks)
  logger.info({ clientId, score }, 'NPS capturado e ticket finalizado')
  return true
}

/** Wire this as the gateway inbound handler. */
export function makeInboundHandler(gateway: WhatsAppGateway) {
  return async (inbound: InboundMessage) => {
    // Dedup: Evolution can deliver the same message more than once (retries,
    // multiple webhook configs). Skip if we've already stored this WA id.
    if (inbound.waMessageId) {
      const [dup] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.waMessageId, inbound.waMessageId))
        .limit(1)
      if (dup) {
        logger.info({ waMessageId: inbound.waMessageId }, 'Mensagem duplicada ignorada')
        return
      }
    }

    const client = await getOrCreateClient(inbound.phone, inbound.pushName)

    // NPS capture: if a survey is pending (sent, no score yet) and this message
    // contains a 0–10 score, record it and finalize the ticket — WITHOUT spawning
    // a new ticket or running the agent. This is the real end of the attendance.
    if (await tryCaptureNps(client.id, inbound.text, gateway, inbound.phone, inbound.waMessageId)) {
      return
    }

    // Smart resume: a ticket auto-closed by INACTIVITY reopens (same subject +
    // context) if the client returns within the window. A MANUALLY finalized
    // ticket does NOT resume — getOrCreateConversation then starts a brand-new
    // conversation/ticket (confirmed product rule).
    const resumed = await maybeResumeOnInbound(client.id)
    let convo: typeof conversations.$inferSelect
    if (resumed?.conversationId) {
      await db
        .update(conversations)
        .set({ status: resumed.handlingMode === 'human' ? 'human' : 'bot' })
        .where(eq(conversations.id, resumed.conversationId))
      const [c] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, resumed.conversationId))
      convo = c!
    } else {
      convo = await getOrCreateConversation(client.id)
    }

    // Every conversation has a ticket from message 1 (AI-handling mode). A fresh
    // conversation after a finalized one gets a brand-new ticket here.
    const activeTicket = await ensureTicket(client.id, convo.id)
    const stored = await storeMessage(convo.id, client.id, 'client', inbound.text, {
      waMessageId: inbound.waMessageId,
      ticketId: activeTicket.id,
    })
    // Lost the race against a duplicate delivery — don't double-reply.
    if (!stored) {
      logger.info({ waMessageId: inbound.waMessageId }, 'Duplicada (corrida) ignorada')
      return
    }

    // If a human operator owns the conversation, the bot stays silent — the
    // operator UI delivers replies. We only persisted the inbound message.
    if (convo.status === 'human' || convo.status === 'waiting_human') {
      logger.info({ phone: inbound.phone, status: convo.status }, 'Bot silent (human-owned)')
      return
    }

    const history = await loadHistory(convo.id)
    let reply
    try {
      reply = await runAgentTurn(history, { clientId: client.id, conversationId: convo.id })
    } catch (err) {
      logger.error({ err, phone: inbound.phone }, 'Agent turn failed')
      reply = { text: 'Tive um problema técnico agora. Já estou chamando um atendente. 🙏', toolsUsed: [] }
    }

    // Never leave the client in silence: if the model returned empty text (rare,
    // but it happens — empty content with no tool, or it ended on a tool round),
    // send a safe fallback so there's always a reply. The only intentional
    // silence is when a human now owns the conversation (handled above).
    const replyText =
      reply.text && reply.text.trim()
        ? reply.text
        : 'Recebi sua mensagem! 😊 Pode me dar um pouquinho mais de detalhe para eu te ajudar melhor?'

    // Re-read the active ticket: a tool (escalar_humano) may have created/changed it.
    const ticketAfter = await activeTicketForConversation(convo.id)
    const botStored = await storeMessage(convo.id, client.id, 'bot', replyText, {
      toolName: reply.toolsUsed.join(',') || undefined,
      ticketId: ticketAfter?.id ?? activeTicket.id,
    })
    // Persist-then-send-then-mark. Marking delivered here is what stops the
    // outbox from resending it (the duplicate the client was seeing). If the
    // send fails, the row stays pending and is retried on reconnect.
    if (botStored) await sendAndMark(gateway, botStored.id, inbound.phone, replyText)
  }
}

/** Used by the operator UI when a human sends a reply. */
export async function sendOperatorReply(
  gateway: WhatsAppGateway,
  conversationId: string,
  text: string,
) {
  const [convo] = await db.select().from(conversations).where(eq(conversations.id, conversationId))
  if (!convo) throw new Error('Conversation not found')
  const [client] = await db.select().from(clients).where(eq(clients.id, convo.clientId))
  if (!client) throw new Error('Client not found')

  if (convo.status !== 'human') {
    await db.update(conversations).set({ status: 'human' }).where(eq(conversations.id, conversationId))
    bus.emitEvent({
      type: 'conversation.status',
      conversationId,
      clientId: client.id,
      status: 'human',
    })
  }

  // Tag to the active ticket; mark first response and move it to "pending"
  // (waiting on the client) the first time the operator replies.
  const activeTicket = await activeTicketForConversation(conversationId)
  if (activeTicket) {
    await markFirstResponse(activeTicket.id)
    if (activeTicket.status === 'open') {
      await transitionTicket(activeTicket.id, 'pending', {
        actor: 'operator',
        note: 'Operador respondeu ao cliente.',
      })
    }
  }
  const stored = await storeMessage(conversationId, client.id, 'operator', text, {
    ticketId: activeTicket?.id,
  })
  // Persist-then-send so an offline number doesn't lose the operator's reply —
  // it's resent automatically when WhatsApp reconnects.
  if (stored) await sendAndMark(gateway, stored.id, client.phone, text)
}
