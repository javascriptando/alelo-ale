import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { tickets, ticketEvents, conversations, type Ticket } from '../db/schema.js'
import { bus } from '../realtime/bus.js'
import { logger } from '../config/logger.js'

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed'
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TicketCategory =
  | 'suporte'
  | 'financeiro'
  | 'cartao'
  | 'comercial'
  | 'reclamacao'
  | 'outro'

// Idle time after "resolved" before a ticket auto-closes.
const AUTO_CLOSE_DAYS = 3
// Idle time (no activity) before an OPEN/PENDING ticket auto-closes by
// inactivity — applies to both AI- and human-handled tickets.
const INACTIVITY_CLOSE_MINUTES = 60
// Window after an inactivity-close during which a returning client RESUMES the
// same ticket (instead of starting a brand-new conversation).
const RESUME_WINDOW_HOURS = 24

/**
 * Allowed status transitions. Anything not listed is rejected — this is the
 * single source of truth for the ticket lifecycle.
 */
const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['pending', 'resolved', 'closed'],
  pending: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'], // -> open = reopen
  closed: ['open'], // -> open = reopen
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}

async function logEvent(
  ticketId: string,
  type: string,
  opts: { from?: string; to?: string; actor?: string; note?: string } = {},
) {
  await db.insert(ticketEvents).values({
    ticketId,
    type,
    fromStatus: opts.from ?? null,
    toStatus: opts.to ?? null,
    actor: opts.actor ?? 'system',
    note: opts.note ?? null,
  })
}

/** Keyword-based priority/category heuristic (the AI can still override). */
export function classify(text: string): { priority: TicketPriority; category: TicketCategory } {
  const t = text.toLowerCase()
  let priority: TicketPriority = 'medium'
  let category: TicketCategory = 'suporte'

  if (/advogad|processar|procon|justiça|fraude|golpe/.test(t)) priority = 'urgent'
  else if (/urgent|parad[oa]|não chegou|nao chegou|sem acesso|bloquead|há dias|ha dias/.test(t))
    priority = 'high'
  else if (/dúvida|duvida|saber|como funciona|informaç/.test(t)) priority = 'low'

  if (/cartã|cartao|entrega|chegou|bloque/.test(t)) category = 'cartao'
  else if (/fatura|cobran|pagamento|boleto|nota fiscal|valor/.test(t)) category = 'financeiro'
  else if (/contrato|cotaç|preço|preco|plano|comercial/.test(t)) category = 'comercial'
  else if (/insatisf|reclam|péssimo|pessimo|horrível|horrivel|cancelar/.test(t))
    category = 'reclamacao'

  return { priority, category }
}

export interface CreateTicketInput {
  clientId: string
  conversationId: string
  subject: string
  reason?: string
  priority?: TicketPriority
  category?: TicketCategory
  actor?: string
  handlingMode?: 'ai' | 'queue' | 'human'
}

export async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  const [ticket] = await db
    .insert(tickets)
    .values({
      clientId: input.clientId,
      conversationId: input.conversationId,
      subject: input.subject.slice(0, 140),
      reason: input.reason,
      priority: input.priority ?? 'medium',
      category: input.category ?? 'suporte',
      status: 'open',
      handlingMode: input.handlingMode ?? 'ai',
      lastActivityAt: new Date(),
    })
    .returning()

  await logEvent(ticket!.id, 'created', {
    to: 'open',
    actor: input.actor ?? 'ai',
    note: input.reason,
  })
  bus.emitEvent({
    type: 'ticket.created',
    ticketId: ticket!.id,
    clientId: input.clientId,
    subject: ticket!.subject,
    priority: ticket!.priority,
  })
  return ticket!
}

/**
 * Every conversation has exactly one active ticket. If none is open/pending,
 * create one in AI-handling mode (shows in the "Com a Alê" list). Called on each
 * inbound so a fresh conversation (after a finalized one) gets a new ticket.
 */
export async function ensureTicket(clientId: string, conversationId: string): Promise<Ticket> {
  const existing = await activeTicketForConversation(conversationId)
  if (existing) return existing
  return createTicket({
    clientId,
    conversationId,
    subject: 'Atendimento iniciado',
    actor: 'ai',
    handlingMode: 'ai',
  })
}

/** The most recent ticket for a client (any status). */
export async function latestTicket(clientId: string): Promise<Ticket | undefined> {
  const [row] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.clientId, clientId))
    .orderBy(desc(tickets.createdAt))
    .limit(1)
  return row
}

/** The currently active (non-terminal) ticket for a conversation, if any. */
export async function activeTicketForConversation(
  conversationId: string,
): Promise<Ticket | undefined> {
  const rows = await db
    .select()
    .from(tickets)
    .where(eq(tickets.conversationId, conversationId))
    .orderBy(desc(tickets.createdAt))
  return rows.find((t) => t.status === 'open' || t.status === 'pending')
}

export async function transitionTicket(
  ticketId: string,
  to: TicketStatus,
  opts: { actor?: string; note?: string; closeReason?: string } = {},
): Promise<Ticket> {
  const [current] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!current) throw new Error('Ticket não encontrado')
  const from = current.status as TicketStatus
  if (!canTransition(from, to)) {
    throw new Error(`Transição inválida: ${from} → ${to}`)
  }

  const now = new Date()
  const patch: Partial<typeof tickets.$inferInsert> = { status: to, lastActivityAt: now }
  const isReopen = (from === 'resolved' || from === 'closed') && to === 'open'
  if (isReopen) {
    patch.reopenCount = current.reopenCount + 1
    patch.resolvedAt = null
    patch.closedAt = null
    patch.closeReason = null
  }
  if (to === 'resolved') patch.resolvedAt = now
  if (to === 'closed') {
    patch.closedAt = now
    patch.closeReason = opts.closeReason ?? 'manual'
    patch.handlingMode = 'ai' // release the slot
  }
  if (isReopen) patch.handlingMode = current.handlingMode // keep mode on manual reopen

  await db.update(tickets).set(patch).where(eq(tickets.id, ticketId))

  // Finalizing (closed) ends the conversation: the next client message starts a
  // brand-new conversation + ticket (confirmed product rule). Reopen un-closes.
  if (to === 'closed' && current.conversationId) {
    await db
      .update(conversations)
      .set({ status: 'closed' })
      .where(eq(conversations.id, current.conversationId))
  }
  if (isReopen && current.conversationId) {
    await db
      .update(conversations)
      .set({ status: 'waiting_human' })
      .where(eq(conversations.id, current.conversationId))
  }

  await logEvent(ticketId, isReopen ? 'reopened' : 'status_change', {
    from,
    to,
    actor: opts.actor ?? 'operator',
    note: opts.note,
  })
  bus.emitEvent({
    type: 'ticket.created', // reuse for any ticket change to refresh the UI list
    ticketId,
    clientId: current.clientId,
    subject: current.subject,
    priority: current.priority,
  })

  const [updated] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  return updated!
}

export async function assignTicket(ticketId: string, operatorId: string | null, actor = 'operator') {
  await db.update(tickets).set({ assignedOperatorId: operatorId }).where(eq(tickets.id, ticketId))
  await logEvent(ticketId, 'assigned', { actor, note: operatorId ?? 'unassigned' })
}

export async function addTicketNote(ticketId: string, note: string, actor = 'operator') {
  await db.update(tickets).set({ lastActivityAt: new Date() }).where(eq(tickets.id, ticketId))
  await logEvent(ticketId, 'note', { actor, note })
}

/** Marks first operator response (for SLA/metrics) the first time it happens. */
export async function markFirstResponse(ticketId: string) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (t && !t.firstResponseAt) {
    await db.update(tickets).set({ firstResponseAt: new Date() }).where(eq(tickets.id, ticketId))
  }
}

/**
 * Manual reopen only (operator clicks "Reabrir"). Per the confirmed product
 * rule, a FINISHED ticket does NOT auto-reopen when the client writes again —
 * that starts a brand-new conversation/ticket instead (see conversation-service
 * getOrCreateConversation + activeTicketForConversation). This function exists
 * for the operator-initiated reopen via the UI/API.
 */
export async function reopenTicket(ticketId: string, actor = 'operator'): Promise<Ticket> {
  return transitionTicket(ticketId, 'open', { actor, note: 'Reaberto manualmente.' })
}

/** Auto-close tickets resolved and idle for AUTO_CLOSE_DAYS (terminal). */
export async function autoCloseStale(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_CLOSE_DAYS * 24 * 60 * 60 * 1000)
  const candidates = await db
    .select()
    .from(tickets)
    .where(eq(tickets.status, 'resolved'))
  let closed = 0
  for (const t of candidates) {
    const ref = t.resolvedAt ?? t.lastActivityAt
    if (ref && ref < cutoff) {
      await transitionTicket(t.id, 'closed', {
        actor: 'system',
        note: 'Fechado automaticamente após resolução.',
        closeReason: 'resolved_idle',
      })
      closed++
    }
  }
  if (closed) logger.info({ closed }, 'Tickets resolvidos auto-fechados')
  return closed
}

/**
 * Auto-close OPEN/PENDING tickets with no activity for INACTIVITY_CLOSE_MINUTES
 * (both AI- and human-handled). These close with reason 'inactivity' and are
 * RESUMABLE: if the client writes again within RESUME_WINDOW_HOURS we reopen the
 * same ticket (see maybeResumeOnInbound). Returns the closed tickets so the
 * caller can notify each client over WhatsApp.
 */
export async function autoCloseInactive(): Promise<Ticket[]> {
  const cutoff = new Date(Date.now() - INACTIVITY_CLOSE_MINUTES * 60 * 1000)
  const candidates = await db
    .select()
    .from(tickets)
    .where(sql`${tickets.status} in ('open','pending')`)
  const closedList: Ticket[] = []
  for (const t of candidates) {
    const ref = t.lastActivityAt ?? t.updatedAt
    if (ref && ref < cutoff) {
      const updated = await transitionTicket(t.id, 'closed', {
        actor: 'system',
        note: `Fechado por inatividade (${INACTIVITY_CLOSE_MINUTES} min sem resposta).`,
        closeReason: 'inactivity',
      })
      closedList.push(updated)
    }
  }
  if (closedList.length) logger.info({ closed: closedList.length }, 'Tickets fechados por inatividade')
  return closedList
}

/**
 * If the client's latest ticket was auto-closed by inactivity within the resume
 * window, reopen it (same subject + context) and return it so the conversation
 * continues where it stopped. Otherwise null (→ a brand-new conversation/ticket).
 */
export async function maybeResumeOnInbound(clientId: string): Promise<Ticket | null> {
  const t = await latestTicket(clientId)
  if (!t || t.status !== 'closed' || t.closeReason !== 'inactivity') return null
  const ref = t.closedAt ?? t.updatedAt
  const windowStart = new Date(Date.now() - RESUME_WINDOW_HOURS * 60 * 60 * 1000)
  if (!ref || ref < windowStart) return null // too old → start fresh

  const reopened = await transitionTicket(t.id, 'open', {
    actor: 'client',
    note: 'Retomado: cliente voltou dentro da janela após fechamento por inatividade.',
  })
  // Restore the handling mode/owner that were active before the inactivity close.
  await db
    .update(tickets)
    .set({ handlingMode: t.handlingMode, assignedOperatorId: t.assignedOperatorId })
    .where(eq(tickets.id, t.id))
  logger.info({ ticketId: t.id }, 'Ticket retomado após inatividade')
  return reopened
}

export { AUTO_CLOSE_DAYS, INACTIVITY_CLOSE_MINUTES, RESUME_WINDOW_HOURS }
