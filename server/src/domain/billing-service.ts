import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, pixCharges, subscriptions } from '../db/schema.js'
import {
  getPaymentPix,
  getSubscription,
  isAsaasConfigured,
  listSubscriptionCharges,
} from '../integrations/asaas.js'
import { notifyImage, notifyText } from './client-notify.js'
import { logger } from '../config/logger.js'
import { brl } from './pricing.js'

/**
 * Recurring-billing keeper ("manter os pagamentos em dia"):
 *  1) syncs each active subscription's nextDueDate from Asaas,
 *  2) imports any NEW monthly charge Asaas generated and sends its PIX to the
 *     client (so "as próximas saem automaticamente todo mês" is actually true),
 *  3) sends a reminder a few days BEFORE the due date and again ON the due day,
 *     so the client always knows when and how to pay the mensalidade.
 *
 * Webhook-free: everything is polled on a gentle cadence by the scheduler.
 */

// Remind this many days before the due date, then again on the due day.
const REMIND_DAYS_BEFORE = 3

function ymd(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}
function daysUntil(dueYmd: string): number {
  const today = ymd(new Date())
  const a = new Date(today + 'T00:00:00')
  const b = new Date(dueYmd + 'T00:00:00')
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000))
}

/** Run one billing cycle: sync subs, import new charges, send due reminders. */
export async function syncSubscriptionsAndRemind(): Promise<void> {
  if (!isAsaasConfigured()) return
  const subs = await db
    .select()
    .from(subscriptions)
    .where(sql`${subscriptions.status} <> 'CANCELED'`)

  for (const sub of subs) {
    // 1) Refresh status + nextDueDate from Asaas.
    const live = await getSubscription(sub.asaasSubscriptionId).catch(() => null)
    if (live) {
      await db
        .update(subscriptions)
        .set({
          status: live.status,
          nextDueDate: live.nextDueDate ? new Date(live.nextDueDate) : sub.nextDueDate,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, sub.id))
    }

    // 2) Import charges we don't have yet and push the PIX for fresh pending ones.
    let charges
    try {
      charges = await listSubscriptionCharges(sub.asaasSubscriptionId)
    } catch (err) {
      logger.error({ err, sub: sub.id }, 'billing: falha ao listar cobranças')
      continue
    }
    for (const ch of charges) {
      const [existing] = await db
        .select()
        .from(pixCharges)
        .where(eq(pixCharges.asaasPaymentId, ch.id))
      if (existing) continue

      await db.insert(pixCharges).values({
        clientId: sub.clientId,
        asaasPaymentId: ch.id,
        subscriptionId: sub.id,
        status: ch.status,
        value: String(ch.value),
        description: sub.description ?? 'Mensalidade Alelo',
        expiresAt: ch.dueDate ? new Date(ch.dueDate + 'T23:59:59') : null,
      })

      // Only proactively send the PIX for an upcoming/pending charge (not for
      // historical paid ones we're just back-filling).
      const pending = !['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(ch.status.toUpperCase())
      const near = ch.dueDate ? daysUntil(ch.dueDate) <= REMIND_DAYS_BEFORE : false
      if (pending && near) await sendChargePix(sub.clientId, ch.id, ch.value, ch.dueDate)
    }

    // 3) Reminder window for the next due date (before + on the day).
    const due = sub.nextDueDate ?? (live?.nextDueDate ? new Date(live.nextDueDate) : null)
    if (due) {
      const dueStr = ymd(due)
      const d = daysUntil(dueStr)
      if (d === REMIND_DAYS_BEFORE || d === 0) {
        const [client] = await db.select().from(clients).where(eq(clients.id, sub.clientId))
        if (client) {
          const when = d === 0 ? 'vence *hoje*' : `vence em *${d} dias* (${dueStr.split('-').reverse().join('/')})`
          await notifyText(
            sub.clientId,
            `🔔 *Lembrete de mensalidade Alelo*\nSua mensalidade de ${brl(Number(sub.value))} ${when}.\nQuer que eu te reenvie o PIX para pagar agora? É só responder *sim*. 💚`,
          ).catch(() => {})
        }
      }
    }
  }
}

/** Send the PIX (QR + copy-paste) for a specific Asaas charge to the client. */
export async function sendChargePix(
  clientId: string,
  asaasPaymentId: string,
  value: number,
  dueDate?: string,
): Promise<boolean> {
  const pix = await getPaymentPix(asaasPaymentId)
  if (!pix) return false
  const venc = dueDate ? ` (vencimento ${dueDate.split('-').reverse().join('/')})` : ''
  await notifyImage(
    clientId,
    pix.pixQrCodeBase64,
    `*Mensalidade Alelo - ${brl(value)}*${venc}\nPague pelo QR Code acima ou pelo código abaixo.`,
  ).catch(() => {})
  await notifyText(clientId, pix.pixCopyPaste).catch(() => {})
  return true
}
