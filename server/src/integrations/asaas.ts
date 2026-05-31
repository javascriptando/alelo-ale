import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * Asaas PIX integration (ported from the 360 project's payments package).
 * Creates a PIX charge and returns the copy-paste code + QR image (base64 PNG),
 * which the Alê sends over WhatsApp.
 */

const BASE = {
  sandbox: 'https://sandbox.asaas.com/api/v3',
  production: 'https://api.asaas.com/v3',
}

// The 360 .env escapes the leading $ as \$ (for bun). The real Asaas token is
// "$aact_…" with no backslash — strip a leading backslash if present.
function apiKey(): string {
  return env.ASAAS_API_KEY.replace(/^\\/, '')
}

export function isAsaasConfigured(): boolean {
  return Boolean(apiKey())
}

function baseUrl(): string {
  return env.ASAAS_ENV === 'production' ? BASE.production : BASE.sandbox
}
function headers() {
  return { 'Content-Type': 'application/json', access_token: apiKey() }
}

/**
 * DEV override: when PIX_DEV_FIXED_VALUE > 0, every charge uses that fixed value
 * (e.g. R$1) so payments can be completed end-to-end during testing.
 */
function chargeValue(real: number): number {
  return env.PIX_DEV_FIXED_VALUE > 0 ? env.PIX_DEV_FIXED_VALUE : real
}

async function asaasGet<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { headers: headers() })
  if (!res.ok) throw new Error(`Asaas GET ${path} -> ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}
async function asaasPost<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Asaas POST ${path} -> ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export interface PixChargeInput {
  customer: { name: string; cpfCnpj?: string; email?: string; phone?: string }
  value: number
  description?: string
  externalReference?: string
  /** days from today until the charge is due (PIX still payable while pending) */
  dueInDays?: number
}

export interface PixCharge {
  id: string
  status: string
  value: number
  invoiceUrl: string
  pixCopyPaste: string
  pixQrCodeBase64: string // raw base64 PNG (no data: prefix)
  expiresAt: string
}

function dateInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** Find an existing Asaas customer by CPF/CNPJ, else create one. */
async function ensureCustomer(c: PixChargeInput['customer']): Promise<string> {
  if (c.cpfCnpj) {
    const onlyDigits = c.cpfCnpj.replace(/\D/g, '')
    if (onlyDigits) {
      const found = await asaasGet<{ data: { id: string }[] }>(
        `/customers?cpfCnpj=${encodeURIComponent(onlyDigits)}`,
      )
      if (found.data?.[0]?.id) return found.data[0].id
    }
  }
  const created = await asaasPost<{ id: string }>('/customers', {
    name: c.name,
    cpfCnpj: c.cpfCnpj?.replace(/\D/g, '') || undefined,
    email: c.email || undefined,
    mobilePhone: c.phone?.replace(/\D/g, '') || undefined,
  })
  return created.id
}

interface AsaasPayment {
  id: string
  status: string
  value: number
  invoiceUrl: string
}
interface AsaasPixQr {
  payload: string
  encodedImage: string
  expirationDate: string
}

export async function createPixCharge(input: PixChargeInput): Promise<PixCharge> {
  const customerId = await ensureCustomer(input.customer)
  const charge = await asaasPost<AsaasPayment>('/payments', {
    customer: customerId,
    billingType: 'PIX',
    value: chargeValue(input.value),
    dueDate: dateInDays(input.dueInDays ?? 3),
    description: input.description,
    externalReference: input.externalReference,
  })
  const qr = await asaasGet<AsaasPixQr>(`/payments/${charge.id}/pixQrCode`)
  logger.info({ chargeId: charge.id, value: charge.value }, 'PIX charge criada')
  return {
    id: charge.id,
    status: charge.status,
    value: charge.value,
    invoiceUrl: charge.invoiceUrl,
    pixCopyPaste: qr.payload,
    pixQrCodeBase64: qr.encodedImage,
    expiresAt: qr.expirationDate,
  }
}

export async function getPaymentStatus(id: string): Promise<string> {
  const p = await asaasGet<{ status: string }>(`/payments/${id}`)
  return p.status
}

/** Fetch the PIX QR + copy-paste for any payment id (used by monthly/overdue). */
export async function getPaymentPix(
  paymentId: string,
): Promise<{ pixCopyPaste: string; pixQrCodeBase64: string } | null> {
  try {
    const qr = await asaasGet<AsaasPixQr>(`/payments/${paymentId}/pixQrCode`)
    return { pixCopyPaste: qr.payload, pixQrCodeBase64: qr.encodedImage }
  } catch {
    return null
  }
}

// ── Recurring billing (subscriptions) — "manter os pagamentos em dia" ──────
export interface SubscriptionInput {
  customer: PixChargeInput['customer']
  value: number
  description?: string
  externalReference?: string
  /** day of month the charge is due (1-28 recommended) */
  dueDay?: number
  /** Start billing only NEXT month (client already paid this cycle as avulsa). */
  startNextMonth?: boolean
}

export interface Subscription {
  id: string
  status: string
  value: number
  nextDueDate: string
}

interface AsaasSubscription {
  id: string
  status: string
  value: number
  nextDueDate: string
}

/** Creates a MONTHLY PIX subscription so Asaas auto-bills the client each cycle. */
export async function createMonthlySubscription(input: SubscriptionInput): Promise<Subscription> {
  const customerId = await ensureCustomer(input.customer)
  const now = new Date()
  const due = new Date()
  due.setDate(Math.min(input.dueDay ?? due.getDate(), 28))
  if (due <= now) due.setMonth(due.getMonth() + 1)
  // Already paid this cycle (avulsa) → first recurring charge only next month,
  // so we never double-charge the same month.
  if (input.startNextMonth && due.getMonth() === now.getMonth() && due.getFullYear() === now.getFullYear()) {
    due.setMonth(due.getMonth() + 1)
  }
  const sub = await asaasPost<AsaasSubscription>('/subscriptions', {
    customer: customerId,
    billingType: 'PIX',
    cycle: 'MONTHLY',
    value: chargeValue(input.value),
    nextDueDate: due.toISOString().slice(0, 10),
    description: input.description,
    externalReference: input.externalReference,
  })
  logger.info({ subscriptionId: sub.id, value: sub.value }, 'Assinatura mensal criada')
  return { id: sub.id, status: sub.status, value: sub.value, nextDueDate: sub.nextDueDate }
}

/** Latest charge generated for a subscription (to fetch its PIX QR/code). */
export async function getSubscriptionLatestCharge(
  subscriptionId: string,
): Promise<{ id: string; status: string; value: number; pixCopyPaste: string; pixQrCodeBase64: string } | null> {
  const list = await asaasGet<{ data: AsaasPayment[] }>(`/subscriptions/${subscriptionId}/payments`)
  const charge = list.data?.[0]
  if (!charge) return null
  const qr = await asaasGet<AsaasPixQr>(`/payments/${charge.id}/pixQrCode`)
  return {
    id: charge.id,
    status: charge.status,
    value: charge.value,
    pixCopyPaste: qr.payload,
    pixQrCodeBase64: qr.encodedImage,
  }
}

export interface AsaasCharge {
  id: string
  status: string
  value: number
  dueDate: string // YYYY-MM-DD
}

/** List all charges of a subscription (newest first), with due dates. */
export async function listSubscriptionCharges(subscriptionId: string): Promise<AsaasCharge[]> {
  const list = await asaasGet<{ data: Array<AsaasPayment & { dueDate: string }> }>(
    `/subscriptions/${subscriptionId}/payments`,
  )
  return (list.data ?? []).map((c) => ({
    id: c.id,
    status: c.status,
    value: c.value,
    dueDate: c.dueDate,
  }))
}

/** Current subscription state (status + next due date) for reminders/UI. */
export async function getSubscription(
  subscriptionId: string,
): Promise<{ status: string; value: number; nextDueDate: string } | null> {
  try {
    const s = await asaasGet<AsaasSubscription>(`/subscriptions/${subscriptionId}`)
    return { status: s.status, value: s.value, nextDueDate: s.nextDueDate }
  } catch {
    return null
  }
}

/** Asaas sends asaas-access-token header == configured webhook token. */
export function verifyAsaasWebhook(received: string | undefined): boolean {
  if (!env.ASAAS_WEBHOOK_TOKEN) return true // no token configured -> accept (dev)
  return received === env.ASAAS_WEBHOOK_TOKEN
}
