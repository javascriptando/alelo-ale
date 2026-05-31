import Fastify, { type FastifyBaseLogger } from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  beneficiaries,
  clients,
  contracts,
  conversations,
  messages,
  npsResponses,
  operators,
  pixCharges,
  quotes,
  subscriptions,
  tickets,
  ticketEvents,
} from '../db/schema.js'
import { env } from '../config/env.js'
import { bus } from '../realtime/bus.js'
import { logger } from '../config/logger.js'
import { sendOperatorReply } from '../domain/conversation-service.js'
import { addTicketNote, assignTicket, transitionTicket } from '../domain/ticket-service.js'
import { suggestReplies } from '../ai/suggest.js'
import { toolExecutors } from '../ai/tools.js'
import { sendImage, sendText } from '../whatsapp/outbound.js'
import { getPaymentPix, verifyAsaasWebhook } from '../integrations/asaas.js'
import { createAndSendPix } from '../domain/payment-service.js'
import { applyProfile, getProfile, saveProfile } from '../domain/whatsapp-profile.js'
import { brl } from '../domain/pricing.js'
import { registerAuthRoutes, requireAuth } from '../auth/routes.js'
import { getConsentUrl, isDocusignConfigured } from '../integrations/docusign.js'
import type { WhatsAppGateway } from '../whatsapp/gateway.js'

export async function buildServer(gateway: WhatsAppGateway) {
  // Cast to FastifyBaseLogger so the app keeps the default FastifyInstance type
  // (the concrete pino type would otherwise leak into every helper signature).
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger })
  // Allow the Next.js panel to send the session cookie cross-origin.
  await app.register(cors, { origin: true, credentials: true })
  await app.register(cookie)
  await app.register(websocket)

  // Auth (login/logout/me) — public except /me which self-guards.
  registerAuthRoutes(app)

  // Everything under /api except /api/auth/* requires a valid operator session.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return
    if (req.url.startsWith('/api/auth/')) return
    return requireAuth(req, reply)
  })

  // ── Health ────────────────────────────────────────────────
  app.get('/health', async () => ({ ok: true, whatsapp: gateway.isReady() }))

  // ── WhatsApp: Evolution webhook receiver + QR for pairing ─
  app.post('/webhook/whatsapp', async (req, reply) => {
    try {
      await gateway.handleWebhook?.(req.body as Record<string, unknown>)
    } catch (err) {
      logger.error({ err }, 'webhook handling failed')
    }
    return reply.code(200).send({ ok: true }) // always 200 so Evolution doesn't retry-storm
  })

  // QR as an HTML page (open in browser to pair) + raw JSON
  app.get('/whatsapp/qr', async (_req, reply) => {
    await (gateway.forceQr?.() ?? gateway.refreshConnection?.())
    const qr = gateway.getQr?.() ?? null
    if (gateway.isReady()) return reply.type('text/html').send('<h2>WhatsApp já conectado ✔</h2>')
    if (!qr) return reply.type('text/html').send('<h2>QR ainda não disponível. Recarregue em instantes…</h2>')
    return reply
      .type('text/html')
      .send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Escaneie no WhatsApp ▸ Aparelhos conectados</h2>
        <img src="${qr}" style="width:320px;height:320px" />
        <p>Atualize a página se expirar.</p>
      </body></html>`)
  })
  // Everyone sees connection status; only admin gets the QR to (re)connect.
  app.get('/api/whatsapp/status', async (req) => {
    // Query Evolution live so the panel reflects real-time connect/disconnect.
    if (gateway.refreshConnection) await gateway.refreshConnection().catch(() => {})
    const isAdmin = req.operator?.role === 'admin'
    return { ready: gateway.isReady(), qr: isAdmin ? (gateway.getQr?.() ?? null) : null, canManage: isAdmin }
  })

  // ── DocuSign: one-time consent + Connect webhook ──────────
  // Open this once in a browser (logged into DocuSign as the integration user)
  // and approve, so JWT impersonation works thereafter.
  app.get('/docusign/consent', async (_req, reply) => {
    if (!isDocusignConfigured()) {
      return reply
        .type('text/html')
        .send('<h2>DocuSign não configurado.</h2><p>Preencha DOCUSIGN_* no .env e cole a private key.</p>')
    }
    const redirect = `${env.PUBLIC_BASE_URL}/docusign/callback`
    return reply.redirect(getConsentUrl(redirect))
  })
  app.get('/docusign/callback', async (req, reply) => {
    // Reflect the REAL outcome (DocuSign sends ?code on success, ?error on fail).
    const q = req.query as { code?: string; error?: string; error_description?: string }
    if (q.error) {
      return reply.type('text/html').send(
        `<body style="font-family:sans-serif;padding:40px"><h2 style="color:#c00">❌ Consentimento não concedido</h2><p><b>${q.error}</b>: ${q.error_description ?? ''}</p></body>`,
      )
    }
    return reply.type('text/html').send(
      `<body style="font-family:sans-serif;padding:40px"><h2 style="color:#00833f">✔ Consentimento concedido</h2><p>Pode fechar esta aba. A Alê já pode enviar contratos.</p></body>`,
    )
  })

  // DocuSign Connect posts envelope status changes here -> mark contract signed.
  app.post('/webhook/docusign', async (req, reply) => {
    try {
      const body = req.body as Record<string, unknown>
      const data = (body?.data ?? body) as Record<string, unknown>
      const envelopeId =
        (data?.envelopeId as string) ??
        ((data?.envelopeSummary as Record<string, unknown>)?.envelopeId as string)
      const status = String(
        (data?.envelopeSummary as Record<string, unknown>)?.status ?? body?.status ?? '',
      ).toLowerCase()
      if (envelopeId && (status === 'completed' || status === 'signed')) {
        const [contract] = await db
          .select()
          .from(contracts)
          .where(eq(contracts.docusignEnvelopeId, envelopeId))
        // Only act on the transition to signed (DocuSign Connect can fire twice).
        if (contract && contract.status !== 'signed') {
          await db
            .update(contracts)
            .set({ status: 'signed', signedAt: new Date() })
            .where(eq(contracts.id, contract.id))
          logger.info({ envelopeId }, 'Contrato assinado (DocuSign Connect)')

          // Payment is a SYSTEM step right after signing: tell the client and
          // generate + send the PIX automatically (no need to ask).
          const [client] = await db.select().from(clients).where(eq(clients.id, contract.clientId))
          if (client) {
            await sendText(
              client.phone,
              '✅ *Contrato assinado!* O próximo passo é o pagamento — já estou gerando seu PIX. 👇',
            ).catch(() => {})
            await createAndSendPix(contract.clientId).catch((err) =>
              logger.error({ err }, 'Falha ao gerar PIX pós-assinatura'),
            )
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'docusign webhook failed')
    }
    return reply.code(200).send({ ok: true })
  })

  // ── Asaas: PIX payment webhook (one-time + recurring) ─────
  // Configure in Asaas: URL <PUBLIC_BASE_URL>/webhook/asaas, token = ASAAS_WEBHOOK_TOKEN.
  // Confirms payments, sends each new monthly charge, and dunning on overdue.
  app.post('/webhook/asaas', async (req, reply) => {
    try {
      const token = req.headers['asaas-access-token'] as string | undefined
      if (!verifyAsaasWebhook(token)) return reply.code(401).send({ error: 'unauthorized' })
      const body = req.body as {
        event?: string
        payment?: { id?: string; status?: string; value?: number; subscription?: string }
      }
      const event = String(body?.event ?? '').toUpperCase()
      const p = body?.payment
      const paymentId = p?.id
      const status = String(p?.status ?? '').toUpperCase()
      if (!paymentId) return reply.code(200).send({ ok: true })

      const paid = ['RECEIVED', 'CONFIRMED'].includes(status) || ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)
      const overdue = status === 'OVERDUE' || event === 'PAYMENT_OVERDUE'
      const created = event === 'PAYMENT_CREATED' // new recurring charge generated

      let [charge] = await db.select().from(pixCharges).where(eq(pixCharges.asaasPaymentId, paymentId))
      let clientId = charge?.clientId
      if (!clientId && p?.subscription) {
        const [sub] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.asaasSubscriptionId, p.subscription))
        clientId = sub?.clientId
        if (clientId && created && !charge) {
          const pix = await getPaymentPix(paymentId)
          const [row] = await db
            .insert(pixCharges)
            .values({
              clientId,
              asaasPaymentId: paymentId,
              status: status || 'PENDING',
              value: String(p?.value ?? 0),
              description: 'Mensalidade Alelo',
              copyPaste: pix?.pixCopyPaste,
            })
            .returning()
          charge = row
        }
      }
      if (!clientId) return reply.code(200).send({ ok: true })
      const [client] = await db.select().from(clients).where(eq(clients.id, clientId))

      if (charge) {
        await db
          .update(pixCharges)
          .set({ status: status || charge.status, paidAt: paid ? new Date() : charge.paidAt })
          .where(eq(pixCharges.id, charge.id))
      }

      if (paid && client && !charge?.paidAt) {
        await sendText(
          client.phone,
          `✅ *Pagamento confirmado!* Recebemos ${brl(Number(p?.value ?? charge?.value ?? 0))}. Obrigado! Seu benefício Alelo segue ativo.`,
        )
        logger.info({ paymentId }, 'Pagamento confirmado e cliente notificado')
      } else if (created && client) {
        const pix = await getPaymentPix(paymentId)
        if (pix) {
          await sendImage(
            client.phone,
            pix.pixQrCodeBase64,
            `*Mensalidade Alelo - ${brl(Number(p?.value ?? 0))}*\nChegou sua fatura do mês. Pague pelo QR ou código abaixo. 👇`,
          ).catch(() => {})
          await sendText(client.phone, pix.pixCopyPaste).catch(() => {})
        }
      } else if (overdue && client) {
        const pix = await getPaymentPix(paymentId)
        await sendText(
          client.phone,
          `⚠️ *Mensalidade em atraso* (${brl(Number(p?.value ?? charge?.value ?? 0))}). Para manter seu benefício ativo, pague o quanto antes pelo PIX abaixo.`,
        ).catch(() => {})
        if (pix) await sendText(client.phone, pix.pixCopyPaste).catch(() => {})
        logger.info({ paymentId }, 'Cobrança em atraso — lembrete enviado')
      }
    } catch (err) {
      logger.error({ err }, 'asaas webhook failed')
    }
    return reply.code(200).send({ ok: true })
  })

  // ── WhatsApp profile (admin): name, about and avatar of the connected number ──
  // Force the WhatsApp connection to restart (recover dead sessions) — admin.
  app.post('/api/whatsapp/reconnect', { preHandler: requireAuth }, async (req, reply) => {
    if (req.operator?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
    if (gateway.reconnect) await gateway.reconnect().catch((err) => logger.warn({ err }, 'reconnect'))
    return { ok: true, ready: gateway.isReady(), qr: gateway.getQr?.() ?? null }
  })

  // Force-logout the connected number so a different one can be paired — admin.
  app.post('/api/whatsapp/disconnect', { preHandler: requireAuth }, async (req, reply) => {
    if (req.operator?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
    if (gateway.disconnect) await gateway.disconnect().catch((err) => logger.warn({ err }, 'disconnect'))
    return { ok: true, ready: gateway.isReady(), qr: gateway.getQr?.() ?? null }
  })

  app.get('/api/whatsapp/profile', { preHandler: requireAuth }, async (req, reply) => {
    if (req.operator?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
    return getProfile()
  })
  app.post('/api/whatsapp/profile', { preHandler: requireAuth }, async (req, reply) => {
    if (req.operator?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
    const body = z
      .object({
        name: z.string().min(1),
        about: z.string().default(''),
        pictureUrl: z.string().optional(),
      })
      .parse(req.body)
    const saved = saveProfile(body)
    await applyProfile(gateway, saved).catch((err) => logger.warn({ err }, 'applyProfile failed'))
    return { ok: true, profile: saved }
  })

  // ── Realtime WebSocket for the operator inbox ─────────────
  app.get('/ws', { websocket: true }, (socket) => {
    const unsub = bus.onEvent((e) => {
      try {
        socket.send(JSON.stringify(e))
      } catch {
        /* socket closing */
      }
    })
    socket.on('close', unsub)
  })

  // ── Conversations / inbox ─────────────────────────────────
  app.get('/api/conversations', async () => {
    const rows = await db
      .select({
        id: conversations.id,
        status: conversations.status,
        lastMessageAt: conversations.lastMessageAt,
        assignedOperatorId: conversations.assignedOperatorId,
        clientId: clients.id,
        companyName: clients.companyName,
        phone: clients.phone,
        stage: clients.stage,
        ownerOperatorId: clients.ownerOperatorId,
      })
      .from(conversations)
      .innerJoin(clients, eq(conversations.clientId, clients.id))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(200)
    return rows
  })

  app.get('/api/conversations/:id/messages', async (req) => {
    const { id } = req.params as { id: string }
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.createdAt)
      .limit(500)
    return rows
  })

  // Operator sends a reply (auto-takes the conversation to "human")
  app.post('/api/conversations/:id/reply', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ text: z.string().min(1) }).parse(req.body)
    try {
      await sendOperatorReply(gateway, id, body.text)
      return { ok: true }
    } catch (err) {
      logger.error({ err }, 'reply failed')
      return reply.code(400).send({ ok: false, error: (err as Error).message })
    }
  })

  // Explicit takeover / release / close
  app.post('/api/conversations/:id/status', async (req) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        status: z.enum(['bot', 'waiting_human', 'human', 'closed']),
        operatorId: z.string().uuid().optional(),
      })
      .parse(req.body)
    await db
      .update(conversations)
      .set({ status: body.status, assignedOperatorId: body.operatorId ?? null })
      .where(eq(conversations.id, id))
    const [c] = await db.select().from(conversations).where(eq(conversations.id, id))
    if (c) {
      bus.emitEvent({
        type: 'conversation.status',
        conversationId: id,
        clientId: c.clientId,
        status: body.status,
      })
    }
    return { ok: true }
  })

  // ── Tickets ───────────────────────────────────────────────
  // mode: 'ai' (Com a Alê) | 'human' (fila/atendimento). scope: 'mine' | 'all'.
  // Admin sees everything (god-mode); operators default to their own + unassigned.
  app.get('/api/tickets', async (req) => {
    const q = req.query as { status?: string; mode?: string; scope?: string }
    const rows = await db
      .select({
        id: tickets.id,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        category: tickets.category,
        reason: tickets.reason,
        summary: tickets.summary,
        handlingMode: tickets.handlingMode,
        reopenCount: tickets.reopenCount,
        createdAt: tickets.createdAt,
        queuedAt: tickets.queuedAt,
        lastActivityAt: tickets.lastActivityAt,
        clientId: clients.id,
        companyName: clients.companyName,
        phone: clients.phone,
        conversationId: tickets.conversationId,
        assignedOperatorId: tickets.assignedOperatorId,
      })
      .from(tickets)
      .innerJoin(clients, eq(tickets.clientId, clients.id))
      .orderBy(desc(tickets.lastActivityAt))
      .limit(300)

    const isAdmin = req.operator?.role === 'admin'
    const meId = req.operator?.id
    return rows.filter((r) => {
      if (q.status && r.status !== q.status) return false
      if (q.mode && r.handlingMode !== q.mode) return false
      // god-mode: admin sees all; or explicit scope=all
      if (isAdmin || q.scope === 'all') return true
      // operator default: AI tickets (anyone can watch) + own + unassigned-in-queue
      if (r.handlingMode === 'ai') return true
      return r.assignedOperatorId === meId || r.assignedOperatorId === null
    })
  })

  // Full ticket detail: ticket + client + its message thread + audit events.
  app.get('/api/tickets/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id))
    if (!ticket) return reply.code(404).send({ error: 'ticket não encontrado' })
    const [client] = await db.select().from(clients).where(eq(clients.id, ticket.clientId))
    const thread = await db
      .select()
      .from(messages)
      .where(eq(messages.ticketId, id))
      .orderBy(messages.createdAt)
    const events = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, id))
      .orderBy(ticketEvents.createdAt, ticketEvents.id)
    return { ticket, client, thread, events }
  })

  // Lifecycle transitions go through ticket-service (enforces valid moves).
  app.post('/api/tickets/:id/transition', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        to: z.enum(['open', 'pending', 'resolved', 'closed']),
        note: z.string().optional(),
      })
      .parse(req.body)
    try {
      const actor = req.operator ? `operator:${req.operator.id}` : 'operator'
      const t = await transitionTicket(id, body.to, { actor, note: body.note })
      return { ok: true, ticket: t }
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message })
    }
  })

  app.post('/api/tickets/:id/assign', async (req) => {
    const { id } = req.params as { id: string }
    const body = z.object({ operatorId: z.string().uuid().nullable() }).parse(req.body)
    const actor = req.operator ? `operator:${req.operator.id}` : 'operator'
    await assignTicket(id, body.operatorId, actor)
    return { ok: true }
  })

  // Operator takes over a ticket (works for AI tickets too — manual pull).
  // Sets handling to human, assigns to self, and makes the conversation human-owned.
  app.post('/api/tickets/:id/take', async (req, reply) => {
    const { id } = req.params as { id: string }
    const me = req.operator
    if (!me) return reply.code(401).send({ error: 'unauthenticated' })
    const [t] = await db.select().from(tickets).where(eq(tickets.id, id))
    if (!t) return reply.code(404).send({ error: 'ticket não encontrado' })
    await db
      .update(tickets)
      .set({ handlingMode: 'human', assignedOperatorId: me.id, lastActivityAt: new Date() })
      .where(eq(tickets.id, id))
    await assignTicket(id, me.id, `operator:${me.id}`)
    if (t.conversationId) {
      await db.update(conversations).set({ status: 'human' }).where(eq(conversations.id, t.conversationId))
      bus.emitEvent({
        type: 'conversation.status',
        conversationId: t.conversationId,
        clientId: t.clientId,
        status: 'human',
      })
    }
    return { ok: true }
  })

  // Hand the ticket back to the Alê (AI resumes the conversation).
  app.post('/api/tickets/:id/return-to-ai', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [t] = await db.select().from(tickets).where(eq(tickets.id, id))
    if (!t) return reply.code(404).send({ error: 'ticket não encontrado' })
    await db
      .update(tickets)
      .set({ handlingMode: 'ai', assignedOperatorId: null, lastActivityAt: new Date() })
      .where(eq(tickets.id, id))
    const actor = req.operator ? `operator:${req.operator.id}` : 'operator'
    await addTicketNote(id, 'Devolvido para a Alê (IA).', actor)
    if (t.conversationId) {
      await db.update(conversations).set({ status: 'bot' }).where(eq(conversations.id, t.conversationId))
      bus.emitEvent({
        type: 'conversation.status',
        conversationId: t.conversationId,
        clientId: t.clientId,
        status: 'bot',
      })
    }
    return { ok: true }
  })

  app.post('/api/tickets/:id/note', async (req) => {
    const { id } = req.params as { id: string }
    const body = z.object({ note: z.string().min(1) }).parse(req.body)
    const actor = req.operator ? `operator:${req.operator.id}` : 'operator'
    await addTicketNote(id, body.note, actor)
    return { ok: true }
  })

  // Update priority/category inline (no lifecycle implications).
  app.post('/api/tickets/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
        category: z
          .enum(['suporte', 'financeiro', 'cartao', 'comercial', 'reclamacao', 'outro'])
          .optional(),
        assignedOperatorId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body)
    if (Object.keys(body).length) await db.update(tickets).set(body).where(eq(tickets.id, id))
    return { ok: true }
  })

  // AI copilot: suggested replies for the operator handling a conversation.
  app.get('/api/conversations/:id/suggestions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [convo] = await db.select().from(conversations).where(eq(conversations.id, id))
    if (!convo) return reply.code(404).send({ error: 'conversa não encontrada' })
    const suggestions = await suggestReplies(id, convo.clientId)
    return { suggestions }
  })

  // ── Clients / portfolio ───────────────────────────────────
  // Operators see only their own portfolio; admins see everything.
  app.get('/api/clients', async (req) => {
    const all = await db.select().from(clients).orderBy(desc(clients.updatedAt)).limit(500)
    if (req.operator?.role === 'admin') return all
    return all.filter((c) => c.ownerOperatorId === req.operator?.id)
  })

  // Client 360: everything an operator needs to resolve end-to-end.
  app.get('/api/clients/:id', async (req) => {
    const { id } = req.params as { id: string }
    const [client] = await db.select().from(clients).where(eq(clients.id, id))
    const [cQuotes, cContracts, cTickets, cBeneficiaries, cPayments, cSubscriptions] =
      await Promise.all([
        db.select().from(quotes).where(eq(quotes.clientId, id)).orderBy(desc(quotes.createdAt)),
        db.select().from(contracts).where(eq(contracts.clientId, id)).orderBy(desc(contracts.createdAt)),
        db.select().from(tickets).where(eq(tickets.clientId, id)).orderBy(desc(tickets.createdAt)),
        db
          .select()
          .from(beneficiaries)
          .where(and(eq(beneficiaries.clientId, id), eq(beneficiaries.active, true))),
        db.select().from(pixCharges).where(eq(pixCharges.clientId, id)).orderBy(desc(pixCharges.createdAt)),
        db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.clientId, id))
          .orderBy(desc(subscriptions.createdAt)),
      ])
    return {
      client,
      quotes: cQuotes,
      contracts: cContracts,
      tickets: cTickets,
      beneficiaries: cBeneficiaries,
      payments: cPayments,
      subscriptions: cSubscriptions,
    }
  })

  // Portfolio assignment is admin-only.
  app.post('/api/clients/:id/assign', async (req, reply) => {
    if (req.operator?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
    const { id } = req.params as { id: string }
    const body = z.object({ operatorId: z.string().uuid().nullable() }).parse(req.body)
    await db.update(clients).set({ ownerOperatorId: body.operatorId }).where(eq(clients.id, id))
    return { ok: true }
  })

  // ── Beneficiaries (associados): manage individually from the panel ────
  // Add one associate manually.
  app.post('/api/clients/:id/beneficiaries', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        name: z.string().min(1),
        cpf: z.string().optional(),
        benefitType: z.enum(['refeicao', 'alimentacao', 'mobilidade', 'multibeneficios']).optional(),
      })
      .parse(req.body)
    const [row] = await db
      .insert(beneficiaries)
      .values({
        clientId: id,
        name: body.name.trim(),
        cpf: body.cpf ? body.cpf.replace(/\D/g, '') : null,
        benefitType: body.benefitType ?? 'refeicao',
      })
      .returning()
    return reply.send({ ok: true, beneficiary: row })
  })

  // Edit an associate (name, cpf, benefit type).
  app.patch('/api/clients/:id/beneficiaries/:bid', async (req, reply) => {
    const { bid } = req.params as { id: string; bid: string }
    const body = z
      .object({
        name: z.string().min(1).optional(),
        cpf: z.string().optional(),
        benefitType: z.enum(['refeicao', 'alimentacao', 'mobilidade', 'multibeneficios']).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body)
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (body.name !== undefined) patch.name = body.name.trim()
    if (body.cpf !== undefined) patch.cpf = body.cpf ? body.cpf.replace(/\D/g, '') : null
    if (body.benefitType !== undefined) patch.benefitType = body.benefitType
    if (body.active !== undefined) patch.active = body.active
    await db.update(beneficiaries).set(patch).where(eq(beneficiaries.id, bid))
    return reply.send({ ok: true })
  })

  // Remove an associate permanently.
  app.delete('/api/clients/:id/beneficiaries/:bid', async (req, reply) => {
    const { bid } = req.params as { id: string; bid: string }
    await db.delete(beneficiaries).where(eq(beneficiaries.id, bid))
    return reply.send({ ok: true })
  })

  // Operator/admin acts on behalf of the client — same powers as the Alê
  // (reuses the AI tool executors so behavior is identical to the bot).
  app.post('/api/clients/:id/action', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) })
      .parse(req.body)
    const allowed = [
      'calcular_cotacao',
      'iniciar_assinatura',
      'cadastrar_beneficiarios',
      'agendar_renovacao',
      'gerenciar_conta',
      'gerar_pagamento_pix',
      'ativar_cobranca_mensal',
      'consultar_pagamentos',
      'confirmar_assinatura',
    ]
    if (!allowed.includes(body.tool)) return reply.code(400).send({ error: 'ação não permitida' })
    const [convo] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.clientId, id))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1)
    const exec = toolExecutors[body.tool]
    if (!exec) return reply.code(400).send({ error: 'ação desconhecida' })
    return exec(body.args, { clientId: id, conversationId: convo?.id ?? '' })
  })

  // ── Operators ─────────────────────────────────────────────
  app.get('/api/operators', async () => {
    return db
      .select({ id: operators.id, name: operators.name, email: operators.email, role: operators.role, active: operators.active })
      .from(operators)
  })

  // ── NPS ───────────────────────────────────────────────────
  app.get('/api/nps', async () => {
    const rows = await db.select().from(npsResponses).orderBy(desc(npsResponses.sentAt)).limit(500)
    const answered = rows.filter((r) => r.score != null)
    const promoters = answered.filter((r) => (r.score ?? 0) >= 9).length
    const detractors = answered.filter((r) => (r.score ?? 0) <= 6).length
    const score = answered.length
      ? Math.round(((promoters - detractors) / answered.length) * 100)
      : null
    return { nps: score, total: answered.length, promoters, detractors, responses: rows }
  })

  // ── Dashboard stats ───────────────────────────────────────
  app.get('/api/stats', async () => {
    const [[clientCount], [openTickets], [waitingHuman], [signedContracts]] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(clients),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(eq(tickets.status, 'open')),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(conversations)
        .where(eq(conversations.status, 'waiting_human')),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(contracts)
        .where(eq(contracts.status, 'signed')),
    ])
    return {
      clients: clientCount?.n ?? 0,
      openTickets: openTickets?.n ?? 0,
      waitingHuman: waitingHuman?.n ?? 0,
      signedContracts: signedContracts?.n ?? 0,
    }
  })

  // Rich dashboard payload. Admin = global view; operator = personal view.
  app.get('/api/dashboard', async (req) => {
    const isAdmin = req.operator?.role === 'admin'
    const meId = req.operator?.id ?? ''
    const now = new Date()
    // Period is selectable from the dashboard UI (?days=7|30|90). Clamp 1..180.
    const daysRaw = Number((req.query as { days?: string }).days)
    const days = Number.isFinite(daysRaw) ? Math.min(180, Math.max(1, Math.trunc(daysRaw))) : 7

    const [
      [clientCount],
      ticketsByStatus,
      ticketsByMode,
      [queueDepth],
      [quoteAgg],
      [contractsSigned],
      [contractsPending],
      [beneficiaryCount],
      [onlineOps],
      recentTickets,
      volumeRows,
    ] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(clients),
      db
        .select({ status: tickets.status, n: sql<number>`count(*)::int` })
        .from(tickets)
        .groupBy(tickets.status),
      db
        .select({ mode: tickets.handlingMode, n: sql<number>`count(*)::int` })
        .from(tickets)
        .groupBy(tickets.handlingMode),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(
          and(eq(tickets.handlingMode, 'human'), sql`${tickets.assignedOperatorId} is null`,
            sql`${tickets.status} in ('open','pending')`),
        ),
      db
        .select({
          n: sql<number>`count(*)::int`,
          sum: sql<number>`coalesce(sum(${quotes.monthlyTotal}),0)::float`,
        })
        .from(quotes),
      db.select({ n: sql<number>`count(*)::int` }).from(contracts).where(eq(contracts.status, 'signed')),
      db.select({ n: sql<number>`count(*)::int` }).from(contracts).where(eq(contracts.status, 'sent')),
      db.select({ n: sql<number>`count(*)::int` }).from(beneficiaries).where(eq(beneficiaries.active, true)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(operators)
        .where(
          and(eq(operators.active, true), sql`${operators.role} <> 'admin'`,
            sql`${operators.lastSeenAt} >= ${new Date(now.getTime() - 60_000).toISOString()}`),
        ),
      db
        .select({
          id: tickets.id,
          subject: tickets.subject,
          status: tickets.status,
          priority: tickets.priority,
          handlingMode: tickets.handlingMode,
          lastActivityAt: tickets.lastActivityAt,
          companyName: clients.companyName,
        })
        .from(tickets)
        .innerJoin(clients, eq(tickets.clientId, clients.id))
        .orderBy(desc(tickets.lastActivityAt))
        .limit(8),
      db
        .select({
          // Bucket by BUSINESS day (America/Sao_Paulo), not UTC — otherwise
          // late-evening BR messages roll into "tomorrow UTC" and fall outside
          // the 7-day window, leaving the chart empty.
          day: sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')`,
          // Split message volume by who handled it so the chart can cross
          // AI (Alê = bot) vs human (operator) attendance per day.
          ai: sql<number>`count(*) filter (where ${messages.role} = 'bot')::int`,
          human: sql<number>`count(*) filter (where ${messages.role} = 'operator')::int`,
          client: sql<number>`count(*) filter (where ${messages.role} = 'client')::int`,
          n: sql<number>`count(*)::int`,
        })
        .from(messages)
        // Widen the filter by 1 extra day so the tz shift can never trim today.
        .where(sql`${messages.createdAt} >= ${new Date(now.getTime() - (days + 1) * 24 * 60 * 60 * 1000).toISOString()}`)
        .groupBy(sql`date_trunc('day', ${messages.createdAt} AT TIME ZONE 'America/Sao_Paulo')`),
    ])

    // Build a continuous 7-day series (fill gaps with 0). Keys are BR-local
    // calendar days (en-CA → YYYY-MM-DD) so they match the SQL buckets above.
    const brDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const volMap = Object.fromEntries(
      volumeRows.map((r) => [r.day, { ai: r.ai, human: r.human, client: r.client, n: r.n }]),
    )
    const volume: { day: string; n: number; ai: number; human: number; client: number }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const key = brDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1000))
      const v = volMap[key] ?? { ai: 0, human: 0, client: 0, n: 0 }
      volume.push({ day: key, n: v.n, ai: v.ai, human: v.human, client: v.client })
    }

    // Role-scoped counts: operator sees their own tickets/queue/portfolio.
    const scopedTickets = await db
      .select({
        status: tickets.status,
        handlingMode: tickets.handlingMode,
        assignedOperatorId: tickets.assignedOperatorId,
      })
      .from(tickets)
    const visible = isAdmin
      ? scopedTickets
      : scopedTickets.filter(
          (t) =>
            t.assignedOperatorId === meId ||
            (t.handlingMode === 'human' && !t.assignedOperatorId) ||
            t.handlingMode === 'ai',
        )
    const c = (p: (t: (typeof visible)[number]) => boolean) => visible.filter(p).length
    const clientRows = await db.select({ ownerOperatorId: clients.ownerOperatorId }).from(clients)
    const myClients = isAdmin ? clientRows.length : clientRows.filter((r) => r.ownerOperatorId === meId).length
    const recentScoped = isAdmin
      ? recentTickets
      : recentTickets.filter((r) => r.handlingMode === 'ai' || r.handlingMode === 'human')

    return {
      scope: isAdmin ? 'admin' : 'operator',
      kpis: {
        clients: myClients,
        openTickets: c((t) => t.status === 'open'),
        pendingTickets: c((t) => t.status === 'pending'),
        resolvedTickets: c((t) => t.status === 'resolved'),
        closedTickets: c((t) => t.status === 'closed'),
        withAI: c((t) => t.handlingMode === 'ai'),
        humanHandling: c((t) => t.handlingMode === 'human'),
        mine: isAdmin ? c((t) => !!t.assignedOperatorId) : c((t) => t.assignedOperatorId === meId),
        queueDepth: c((t) => t.handlingMode === 'human' && !t.assignedOperatorId),
        onlineOperators: onlineOps?.n ?? 0,
        quotes: quoteAgg?.n ?? 0,
        quotesMonthlyTotal: quoteAgg?.sum ?? 0,
        contractsSigned: contractsSigned?.n ?? 0,
        contractsPending: contractsPending?.n ?? 0,
        beneficiaries: beneficiaryCount?.n ?? 0,
      },
      recent: recentScoped,
      volume,
    }
  })

  return app
}
