import { and, isNull, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, notifications } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from '../config/logger.js'
import { autoCloseInactive, autoCloseStale } from '../domain/ticket-service.js'
import { pollPendingPixCharges, pollPendingSignatures } from '../domain/payment-service.js'
import { syncSubscriptionsAndRemind } from '../domain/billing-service.js'
import { drainQueue } from '../domain/assignment-service.js'
import { flushOutbox } from '../domain/outbox.js'
import type { WhatsAppGateway } from '../whatsapp/gateway.js'

const POLL_MS = 60_000
// Resolved-idle auto-close runs less often than the notification poll.
const AUTO_CLOSE_EVERY_MS = 30 * 60_000
// Inactivity auto-close checks every few minutes (catches the ~1h idle window).
const INACTIVITY_EVERY_MS = 5 * 60_000
// Webhook-free PIX reconciliation: poll pending charges on a gentle cadence.
// 30s in dev so a payment is recognized quickly during end-to-end testing.
const PIX_POLL_EVERY_MS = 30_000
// Recurring billing sync + reminders: hourly is plenty (due dates are daily).
const BILLING_EVERY_MS = 60 * 60_000
let lastAutoClose = 0
let lastInactivity = 0
let lastPixPoll = 0
let lastBilling = 0

/**
 * Lightweight DB-backed scheduler: every minute it sends any notification whose
 * scheduledFor is due. Renewals, NPS surveys and follow-ups all flow through
 * the `notifications` table. (For high volume, swap this poller for the BullMQ
 * queue already in deps — same `notifications` rows as the source of truth.)
 */
export function startScheduler(gateway: WhatsAppGateway) {
  const tick = async () => {
    // Keep the connection flag in sync with Evolution — self-heals `ready` after
    // restarts/reconnects so the bot doesn't stay silent thinking it's offline.
    if (gateway.refreshConnection) await gateway.refreshConnection().catch(() => {})

    // Safety net: even if the onReady hook is missed, flush any pending outbound
    // messages every tick while connected (cheap no-op when the queue is empty).
    if (gateway.isReady()) flushOutbox(gateway).catch((err) => logger.error({ err }, 'flushOutbox tick'))

    // Ticket auto-close doesn't need WhatsApp; run it on its own cadence.
    if (Date.now() - lastAutoClose > AUTO_CLOSE_EVERY_MS) {
      lastAutoClose = Date.now()
      autoCloseStale().catch((err) => logger.error({ err }, 'autoCloseStale failed'))
    }
    // Inactivity auto-close (both AI and human tickets). Notify each client that
    // we closed for now and they can just reply to resume the same subject.
    if (Date.now() - lastInactivity > INACTIVITY_EVERY_MS) {
      lastInactivity = Date.now()
      autoCloseInactive()
        .then(async (closed) => {
          if (!gateway.isReady()) return
          for (const t of closed) {
            const [client] = await db.select().from(clients).where(eq(clients.id, t.clientId))
            if (client) {
              await gateway
                .sendText(
                  client.phone,
                  'Encerrei este atendimento por inatividade. 😉 Se quiser retomar de onde paramos, é só me responder aqui que eu continuo o mesmo assunto.',
                )
                .catch(() => {})
            }
          }
        })
        .catch((err) => logger.error({ err }, 'autoCloseInactive failed'))
    }
    // Poll Asaas for pending PIX payments (no webhook needed). Bounded per tick.
    if (Date.now() - lastPixPoll > PIX_POLL_EVERY_MS) {
      lastPixPoll = Date.now()
      pollPendingPixCharges().catch((err) => logger.error({ err }, 'pollPendingPixCharges failed'))
      pollPendingSignatures().catch((err) => logger.error({ err }, 'pollPendingSignatures failed'))
    }
    // Recurring billing: keep subscriptions in sync, import new monthly charges,
    // and remind clients before/on the due date so they pay the mensalidade.
    if (Date.now() - lastBilling > BILLING_EVERY_MS) {
      lastBilling = Date.now()
      syncSubscriptionsAndRemind().catch((err) => logger.error({ err }, 'billing sync failed'))
    }
    // Keep the human queue flowing to online operators every tick.
    drainQueue().catch((err) => logger.error({ err }, 'drainQueue failed'))
    if (!gateway.isReady()) return
    try {
      const due = await db
        .select()
        .from(notifications)
        .where(and(isNull(notifications.sentAt), lte(notifications.scheduledFor, new Date())))
        .limit(50)

      for (const n of due) {
        const [client] = await db.select().from(clients).where(eq(clients.id, n.clientId))
        if (!client) continue
        const text = buildText(n.kind, n.payload)
        try {
          await gateway.sendText(client.phone, text)
          await db.update(notifications).set({ sentAt: new Date() }).where(eq(notifications.id, n.id))
          logger.info({ kind: n.kind, phone: client.phone }, 'Notification sent')
        } catch (err) {
          logger.error({ err, id: n.id }, 'Failed to send notification')
        }
      }
    } catch (err) {
      logger.error({ err }, 'Scheduler tick failed')
    }
  }

  const timer = setInterval(() => void tick(), POLL_MS)
  void tick()
  return () => clearInterval(timer)
}

function buildText(kind: string, payload: Record<string, unknown> | null): string {
  const note = typeof payload?.note === 'string' ? payload.note : ''
  switch (kind) {
    case 'renewal':
      return `🔔 *Lembrete de renovação Alelo*\n${note || 'Seu benefício está próximo da renovação. Quer que eu prepare a continuidade?'}`
    case 'nps':
      return `📊 De 0 a 10, o quanto você recomendaria a Alelo para um colega de RH? Responda com o número, por favor.`
    case 'quote_followup':
      return `Olá! Passando para saber se ficou alguma dúvida sobre a cotação que enviei. Posso seguir com a assinatura? ✍️`
    default:
      return note || 'Você tem uma atualização da Alelo.'
  }
}
