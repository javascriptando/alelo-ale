import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, contracts, pixCharges, quotes } from '../db/schema.js'
import { createPixCharge, getPaymentStatus, isAsaasConfigured } from '../integrations/asaas.js'
import { getEnvelopeStatus, isDocusignConfigured } from '../integrations/docusign.js'
import { advanceStage, notifyImage, notifyText } from './client-notify.js'
import { logger } from '../config/logger.js'
import { brl } from './pricing.js'

// Asaas statuses that mean the money arrived.
const PAID_STATUSES = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']
// Cap per polling tick so we never hammer the Asaas API ("sem extrapolar").
const POLL_MAX = 30
// Stop polling a charge this long after it expired (avoids endless polling).
const EXPIRE_GRACE_MS = 24 * 60 * 60 * 1000

function isPaid(status: string): boolean {
  return PAID_STATUSES.includes(status.toUpperCase())
}

async function confirmAndNotify(charge: typeof pixCharges.$inferSelect): Promise<void> {
  await advanceStage(charge.clientId, 'active')
  // A subscription charge (mensalidade) is a recurring renewal — just thank the
  // client. The "envie a lista de colaboradores" ask is ONLY for the first/setup
  // payment (no subscriptionId), where we still need to onboard the employees.
  if (charge.subscriptionId) {
    await notifyText(
      charge.clientId,
      `✅ *Mensalidade confirmada!* Recebemos ${brl(Number(charge.value))}. Seu benefício segue ativo — obrigado! 💚`,
    )
    return
  }
  await notifyText(
    charge.clientId,
    `✅ *Pagamento confirmado!* Recebemos ${brl(Number(charge.value))}. Obrigado!\n\nPara finalizar, me envie agora a *lista de colaboradores* que vão receber o benefício — pode ser um arquivo CSV (nome,cpf) ou colar a lista aqui no chat.`,
  )
}

/**
 * Create a PIX charge for a client and deliver it over WhatsApp (QR image +
 * copy-paste). Shared by the AI tool, the operator panel and the automatic
 * post-signature step. If no value is given, uses the client's latest quote.
 */
export async function createAndSendPix(
  clientId: string,
  opts: { value?: number; description?: string } = {},
): Promise<{ ok: boolean; chargeId?: string; value?: number; message: string }> {
  if (!isAsaasConfigured()) return { ok: false, message: 'Asaas não configurado.' }
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId))
  if (!client) return { ok: false, message: 'Cliente não encontrado.' }

  let value = Number(opts.value ?? 0)
  if (!value || value <= 0) {
    const qs = await db.select().from(quotes).where(eq(quotes.clientId, clientId))
    const last = qs.at(-1)
    value = last ? Number(last.monthlyTotal) : 0
  }
  if (!value || value <= 0) return { ok: false, message: 'Sem valor para cobrar (faça uma cotação).' }

  const description = opts.description?.trim() || `Benefício Alelo - ${client.companyName}`
  let charge
  try {
    charge = await createPixCharge({
      customer: {
        name: client.contactName || client.companyName,
        cpfCnpj: client.cnpj || undefined,
        email: client.email || undefined,
        phone: client.phone,
      },
      value,
      description,
      externalReference: `client:${client.id}`,
    })
  } catch (err) {
    logger.error({ err }, 'createAndSendPix: falha ao criar cobrança')
    return { ok: false, message: 'Não consegui gerar o PIX agora.' }
  }

  await db.insert(pixCharges).values({
    clientId,
    asaasPaymentId: charge.id,
    status: charge.status,
    value: String(charge.value),
    description,
    copyPaste: charge.pixCopyPaste,
    invoiceUrl: charge.invoiceUrl,
    expiresAt: charge.expiresAt ? new Date(charge.expiresAt) : null,
  })

  try {
    await notifyImage(
      clientId,
      charge.pixQrCodeBase64,
      `*Pagamento PIX - ${brl(charge.value)}*\nEscaneie o QR Code acima ou use o código abaixo. 👇`,
    )
    await notifyText(clientId, charge.pixCopyPaste)
    await notifyText(
      clientId,
      'Copie o código acima e cole no app do seu banco (PIX Copia e Cola). Assim que o pagamento for confirmado, eu te aviso por aqui. ✅',
    )
  } catch (err) {
    logger.error({ err }, 'createAndSendPix: falha ao enviar PIX')
  }

  return {
    ok: true,
    chargeId: charge.id,
    value: charge.value,
    message: `PIX de ${brl(charge.value)} enviado ao cliente.`,
  }
}

/**
 * Webhook-free reconciliation: poll Asaas for the status of PENDING PIX charges
 * and update them. On first confirmation, notify the client over WhatsApp.
 * Bounded by POLL_MAX per call and skips long-expired charges. Returns how many
 * were newly confirmed.
 */
export async function pollPendingPixCharges(): Promise<number> {
  const pending = await db
    .select()
    .from(pixCharges)
    .where(eq(pixCharges.status, 'PENDING'))
    .limit(POLL_MAX)

  let confirmed = 0
  for (const c of pending) {
    if (c.expiresAt && c.expiresAt.getTime() < Date.now() - EXPIRE_GRACE_MS) continue
    let status: string
    try {
      status = await getPaymentStatus(c.asaasPaymentId)
    } catch (err) {
      logger.error({ err, id: c.id }, 'poll pix status failed')
      continue
    }
    if (status === c.status) continue
    const paid = isPaid(status)
    await db
      .update(pixCharges)
      .set({ status, paidAt: paid ? new Date() : c.paidAt })
      .where(eq(pixCharges.id, c.id))
    if (paid && !c.paidAt) {
      await confirmAndNotify(c)
      confirmed++
      logger.info({ id: c.id }, 'PIX confirmado via polling')
    }
  }
  if (confirmed) logger.info({ confirmed }, 'PIX confirmados no polling')
  return confirmed
}

/**
 * Webhook-free signature detection: poll DocuSign for contracts still "sent".
 * When an envelope is completed, mark the contract signed, tell the client and
 * trigger the payment step automatically — so the flow never stalls after the
 * client signs (the DocuSign Connect webhook can't reach a localhost dev server).
 */
export async function pollPendingSignatures(): Promise<number> {
  if (!isDocusignConfigured()) return 0
  const pending = await db.select().from(contracts).where(eq(contracts.status, 'sent')).limit(20)
  let confirmed = 0
  for (const c of pending) {
    if (!c.docusignEnvelopeId) continue
    let status = ''
    try {
      status = (await getEnvelopeStatus(c.docusignEnvelopeId)).toLowerCase()
    } catch (err) {
      logger.error({ err, id: c.id }, 'poll signature status failed')
      continue
    }
    if (status === 'completed' || status === 'signed') {
      await db
        .update(contracts)
        .set({ status: 'signed', signedAt: new Date() })
        .where(eq(contracts.id, c.id))
      await advanceStage(c.clientId, 'active')
      await notifyText(
        c.clientId,
        '✅ *Contrato assinado!* O próximo passo é o pagamento — já estou gerando seu PIX. 👇',
      )
      await createAndSendPix(c.clientId).catch((err) =>
        logger.error({ err }, 'Falha ao gerar PIX pós-assinatura (polling)'),
      )
      confirmed++
      logger.info({ id: c.id }, 'Assinatura detectada via polling DocuSign')
    }
  }
  if (confirmed) logger.info({ confirmed }, 'Assinaturas confirmadas no polling')
  return confirmed
}

/**
 * On-demand reconciliation of ALL of a client's unpaid charges against Asaas.
 * Used by the AI when the client says "já paguei" / sends a comprovante, so we
 * confirm immediately instead of waiting for the 30s poll (fixes "não
 * reconheceu que paguei"). Updates status + advances stage. Does NOT send its
 * own WhatsApp message — the AI composes the reply from the returned data.
 */
export async function reconcileClientCharges(
  clientId: string,
): Promise<{ confirmed: number; stillPending: number; lastPaidValue?: number }> {
  const charges = await db.select().from(pixCharges).where(eq(pixCharges.clientId, clientId))
  let confirmed = 0
  let stillPending = 0
  let lastPaidValue: number | undefined
  for (const c of charges) {
    if (c.paidAt) continue
    let status = c.status
    try {
      status = await getPaymentStatus(c.asaasPaymentId)
    } catch {
      stillPending++
      continue
    }
    const paid = isPaid(status)
    await db
      .update(pixCharges)
      .set({ status, paidAt: paid ? new Date() : c.paidAt })
      .where(eq(pixCharges.id, c.id))
    if (paid) {
      confirmed++
      lastPaidValue = Number(c.value)
      await advanceStage(clientId, 'active')
    } else {
      stillPending++
    }
  }
  return { confirmed, stillPending, lastPaidValue }
}

/**
 * On-demand check of a single charge (for a manual "já pagou?" endpoint).
 * Updates the row and notifies on first confirmation. Returns the live status.
 */
export async function checkPixCharge(
  chargeId: string,
): Promise<{ status: string; paid: boolean } | null> {
  const [c] = await db.select().from(pixCharges).where(eq(pixCharges.id, chargeId))
  if (!c) return null
  let status = c.status
  try {
    status = await getPaymentStatus(c.asaasPaymentId)
  } catch (err) {
    logger.error({ err, id: c.id }, 'check pix status failed')
  }
  const paid = isPaid(status)
  await db
    .update(pixCharges)
    .set({ status, paidAt: paid && !c.paidAt ? new Date() : c.paidAt })
    .where(eq(pixCharges.id, c.id))
  if (paid && !c.paidAt) await confirmAndNotify(c)
  return { status, paid }
}
