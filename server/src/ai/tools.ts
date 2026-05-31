import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  beneficiaries,
  clients,
  contracts,
  conversations,
  notifications,
  npsResponses,
  pixCharges,
  quotes,
  subscriptions,
  tickets,
} from '../db/schema.js'
import { bus } from '../realtime/bus.js'
import { brl, calculateQuote, type BenefitType } from '../domain/pricing.js'
import {
  createMonthlySubscription,
  getPaymentPix,
  getSubscriptionLatestCharge,
  isAsaasConfigured,
} from '../integrations/asaas.js'
import { advanceStage, notifyImage, notifyText } from '../domain/client-notify.js'
import { onlyDigits } from '../domain/validation.js'
import { createAndSendPix, reconcileClientCharges } from '../domain/payment-service.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { isDocusignConfigured, sendContractForSignature, shortenUrl } from '../integrations/docusign.js'
import {
  activeTicketForConversation,
  classify,
  createTicket,
  transitionTicket,
} from '../domain/ticket-service.js'
import { routeToQueue } from '../domain/assignment-service.js'

/** Context passed to every tool executor for the current conversation. */
export interface ToolContext {
  clientId: string
  conversationId: string
}

/** OpenAI tool/function schemas exposed to the model. */
export const toolSchemas: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'calcular_cotacao',
      description:
        'Calcula o valor mensal do benefício Alelo para a empresa do cliente com base no número de colaboradores e nos benefícios desejados. Use sempre que o cliente pedir um orçamento/cotação.',
      parameters: {
        type: 'object',
        properties: {
          headcount: { type: 'integer', description: 'Número de colaboradores' },
          useSuggestedValue: {
            type: 'boolean',
            description:
              'Passe true SOMENTE quando o cliente aceitar o valor sugerido padrão da Alelo sem informar um valor próprio.',
          },
          benefits: {
            type: 'array',
            description: 'Benefícios desejados',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['refeicao', 'alimentacao', 'mobilidade', 'multibeneficios'],
                },
                monthlyValuePerEmployee: {
                  type: 'number',
                  description: 'Valor mensal por colaborador (BRL). Opcional.',
                },
              },
              required: ['type'],
            },
          },
        },
        required: ['headcount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_conta',
      description:
        'Consulta os dados da conta da empresa do cliente: estágio, número de colaboradores/beneficiários cadastrados e contratos. Use quando o cliente perguntar sobre a própria conta.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_pagamentos',
      description:
        'Consulta o histórico de pagamentos PIX do cliente (pagos e pendentes). Se houver cobrança pendente, reenvia o QR Code e o código copia e cola para o cliente pagar. Use quando o cliente perguntar sobre seus pagamentos ou pedir uma nova via de PIX.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'iniciar_assinatura',
      description:
        'Gera o contrato e envia o link de assinatura por DocuSign quando o cliente aceita a cotação. Requer uma cotação existente E os dados do assinante. ANTES de chamar, colete: nome completo do responsável que vai assinar, e-mail válido, e CNPJ da empresa. Passe-os nos parâmetros.',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string', description: 'ID da cotação aceita (opcional, usa a última se vazio)' },
          companyName: { type: 'string', description: 'Razão social / nome da empresa' },
          signerName: { type: 'string', description: 'Nome completo de quem vai assinar (responsável)' },
          signerEmail: { type: 'string', description: 'E-mail válido do assinante' },
          cnpj: { type: 'string', description: 'CNPJ da empresa' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agendar_renovacao',
      description:
        'Agenda um lembrete de renovação de benefício para ser enviado por WhatsApp em uma data futura.',
      parameters: {
        type: 'object',
        properties: {
          daysFromNow: { type: 'integer', description: 'Em quantos dias enviar o lembrete' },
          note: { type: 'string', description: 'Texto do lembrete' },
        },
        required: ['daysFromNow'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalar_humano',
      description:
        'Escala a conversa para um operador humano da Alelo. Use quando o pedido for complexo, sensível, fora do escopo, ou quando o cliente pedir um atendente. ANTES de escalar, procure captar o essencial do que o cliente quer para preencher o resumo (summary), assim o atendente já começa informado.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Motivo curto da escalada (vira o assunto do ticket)' },
          summary: {
            type: 'string',
            description:
              'Resumo do que o cliente precisa, com os dados já coletados (empresa, contexto, o que tentou), para o atendente humano começar informado.',
          },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cadastrar_beneficiarios',
      description:
        'Cadastra a lista de colaboradores (beneficiários) da empresa do cliente. Use quando o RH enviar os nomes/dados dos funcionários que vão receber o benefício. Aceita vários de uma vez.',
      parameters: {
        type: 'object',
        properties: {
          beneficiaries: {
            type: 'array',
            description: 'Lista de colaboradores a cadastrar',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Nome do colaborador' },
                cpf: { type: 'string', description: 'CPF (opcional)' },
                benefitType: {
                  type: 'string',
                  enum: ['refeicao', 'alimentacao', 'mobilidade', 'multibeneficios'],
                  description: 'Tipo de benefício (opcional, padrão refeicao)',
                },
                monthlyValue: {
                  type: 'number',
                  description: 'Valor mensal por colaborador em BRL (opcional)',
                },
              },
              required: ['name'],
            },
          },
        },
        required: ['beneficiaries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gerenciar_conta',
      description:
        'Atualiza dados da empresa do cliente ou ativa/desativa beneficiários. Use para editar nome da empresa, CNPJ, contato, ou desativar um colaborador que saiu.',
      parameters: {
        type: 'object',
        properties: {
          companyName: { type: 'string', description: 'Novo nome da empresa (opcional)' },
          cnpj: { type: 'string', description: 'CNPJ (opcional)' },
          contactName: { type: 'string', description: 'Nome do contato/RH (opcional)' },
          email: { type: 'string', description: 'E-mail de contato (opcional)' },
          deactivateBeneficiaryName: {
            type: 'string',
            description: 'Nome do beneficiário a desativar (opcional)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_nps',
      description:
        'Dispara a pesquisa de satisfação (NPS, nota 0 a 10) para o cliente ao final de um atendimento resolvido. Use quando o cliente confirmar que o problema/solicitação foi resolvido.',
      parameters: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'Sobre o que foi o atendimento (opcional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gerar_pagamento_pix',
      description:
        'Gera uma cobrança PIX AVULSA (Asaas) e envia ao cliente pelo WhatsApp o QR Code (imagem) e o código copia e cola. Use quando o cliente quiser PAGAR uma vez. Se não informar valor, usa o total mensal da última cotação.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'Valor do PIX em BRL. Opcional (usa a última cotação).' },
          description: { type: 'string', description: 'Descrição da cobrança (opcional).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ativar_cobranca_mensal',
      description:
        'Ativa a cobrança recorrente MENSAL do benefício via Asaas (mantém os pagamentos em dia automaticamente). Todo mês o Asaas gera um novo PIX e o cliente é avisado. Use quando o cliente fechar o contrato e quiser pagar mensalmente. Se não informar valor, usa o total mensal da última cotação.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'Valor mensal em BRL. Opcional (usa a última cotação).' },
          dueDay: { type: 'integer', description: 'Dia do vencimento (1-28). Opcional.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_assinatura',
      description:
        'Confirma que o cliente concluiu a assinatura do contrato (DocuSign). Use SEMPRE que o cliente disser que assinou/finalizou. Marca o contrato como assinado e dispara o pagamento (PIX) automaticamente — não espere o cliente pedir o pagamento.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
]

type ToolResult = { ok: boolean; data?: unknown; message: string }

export const toolExecutors: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  async calcular_cotacao(args, ctx) {
    const headcount = Number(args.headcount ?? 0)
    const benefits = (Array.isArray(args.benefits) ? args.benefits : []) as {
      type: BenefitType
      monthlyValuePerEmployee?: number
    }[]
    if (!headcount || headcount < 1) return { ok: false, message: 'headcount inválido' }

    // Não cotar sem o valor do benefício: ou o cliente informa o valor por
    // colaborador, ou aceita explicitamente o valor sugerido (useSuggestedValue).
    const hasValue = benefits.some(
      (b) => typeof b.monthlyValuePerEmployee === 'number' && b.monthlyValuePerEmployee > 0,
    )
    if (!hasValue && args.useSuggestedValue !== true) {
      return {
        ok: false,
        data: { needsBenefitValue: true },
        message:
          'Antes de cotar, pergunte ao cliente qual o valor mensal do benefício por colaborador (e qual benefício: refeição, alimentação, mobilidade ou multibenefícios). Ofereça o valor sugerido padrão da Alelo. Quando ele informar o valor, chame novamente passando monthlyValuePerEmployee; se preferir o padrão, chame com useSuggestedValue=true.',
      }
    }

    const result = calculateQuote({ headcount, benefits })
    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const [row] = await db
      .insert(quotes)
      .values({
        clientId: ctx.clientId,
        status: 'sent',
        headcount,
        input: { headcount, benefits },
        result: result as unknown as Record<string, unknown>,
        monthlyTotal: String(result.monthlyTotal),
        validUntil,
      })
      .returning()

    if (row) {
      bus.emitEvent({
        type: 'quote.created',
        quoteId: row.id,
        clientId: ctx.clientId,
        monthlyTotal: result.monthlyTotal,
      })
    }
    await advanceStage(ctx.clientId, 'quoting')

    return {
      ok: true,
      data: { quoteId: row?.id, ...result },
      message: `Cotação: total mensal Alelo ${brl(result.monthlyTotal)} para ${headcount} colaboradores (válida 30 dias).`,
    }
  },

  async consultar_conta(_args, ctx) {
    const [client] = await db.select().from(clients).where(eq(clients.id, ctx.clientId))
    const benef = await db
      .select()
      .from(beneficiaries)
      .where(and(eq(beneficiaries.clientId, ctx.clientId), eq(beneficiaries.active, true)))
    const ctr = await db.select().from(contracts).where(eq(contracts.clientId, ctx.clientId))
    return {
      ok: true,
      data: {
        empresa: client?.companyName,
        estagio: client?.stage,
        colaboradores: client?.headcount,
        beneficiariosCadastrados: benef.length,
        contratos: ctr.map((c) => ({ status: c.status, assinadoEm: c.signedAt })),
      },
      message: 'Dados da conta consultados.',
    }
  },

  async consultar_pagamentos(_args, ctx) {
    const [client] = await db.select().from(clients).where(eq(clients.id, ctx.clientId))
    if (!client) return { ok: false, message: 'Cliente não encontrado.' }

    const charges = await db
      .select()
      .from(pixCharges)
      .where(eq(pixCharges.clientId, ctx.clientId))
      .orderBy(desc(pixCharges.createdAt))

    if (charges.length === 0) {
      return { ok: true, data: { total: 0 }, message: 'Ainda não há cobranças registradas para este cliente.' }
    }

    const isPaid = (c: (typeof charges)[number]) => Boolean(c.paidAt)
    const isPending = (c: (typeof charges)[number]) =>
      !c.paidAt && (c.status ?? '').toUpperCase() === 'PENDING'
    const pending = charges.filter(isPending)

    // Resend QR + copy-paste for every pending charge so the client can pay now.
    for (const c of pending) {
      const pix = await getPaymentPix(c.asaasPaymentId).catch(() => null)
      if (pix) {
        await notifyImage(
          ctx.clientId,
          pix.pixQrCodeBase64,
          `*PIX pendente - ${brl(Number(c.value))}*\n${c.description ?? 'Benefício Alelo'}\nPague pelo QR Code acima ou pelo código abaixo. 👇`,
        )
        await notifyText(ctx.clientId, pix.pixCopyPaste)
      }
    }

    const lines = charges.slice(0, 10).map((c) => {
      const status = isPaid(c) ? 'PAGO ✅' : isPending(c) ? 'PENDENTE ⏳' : (c.status ?? '—')
      const when = (c.paidAt ?? c.createdAt)?.toISOString().slice(0, 10) ?? ''
      return `• ${brl(Number(c.value))} — ${status}${when ? ` (${when})` : ''}`
    })

    return {
      ok: true,
      data: {
        total: charges.length,
        pagos: charges.filter(isPaid).length,
        pendentes: pending.length,
      },
      message:
        `Resumo de pagamentos:\n${lines.join('\n')}` +
        (pending.length
          ? `\n\nReenviei ${pending.length === 1 ? 'o PIX pendente' : 'os PIX pendentes'} para você concluir o pagamento.`
          : '\n\nTudo em dia, não há pagamentos pendentes. 🎉'),
    }
  },

  async iniciar_assinatura(args, ctx) {
    const quoteId = typeof args.quoteId === 'string' ? args.quoteId : undefined
    const list = await db.select().from(quotes).where(eq(quotes.clientId, ctx.clientId))
    const quote = quoteId ? list.find((q) => q.id === quoteId) : list.at(-1)
    if (!quote) return { ok: false, message: 'Nenhuma cotação encontrada para assinar.' }

    const [client] = await db.select().from(clients).where(eq(clients.id, ctx.clientId))
    if (!client) return { ok: false, message: 'Cliente não encontrado.' }

    // Reject placeholder/garbage values: the AI must NOT fabricate data to get
    // past the gate (it once sent "(não informado)" as the company/signer).
    const isPlaceholder = (v: string): boolean => {
      const s = v.trim().toLowerCase().replace(/[()]/g, '')
      if (!s) return true
      return [
        'não informado', 'nao informado', 'a confirmar', 'a definir', 'n/a', 'na',
        'sem nome', 'desconhecido', 'pendente', 'informar', 'não sei', 'nao sei', '-', '--',
      ].some((p) => s === p || s.includes('não informad') || s.includes('nao informad'))
    }
    const clean = (v: unknown): string => {
      const s = typeof v === 'string' ? v.trim() : ''
      return isPlaceholder(s) ? '' : s
    }

    // Merge any data the AI collected into the client record. The auto-created
    // companyName placeholder ("… (a confirmar)") doesn't count as provided.
    const knownCompany =
      client.companyName && !/\(a confirmar\)|informad/i.test(client.companyName) ? client.companyName : ''
    const knownContact = client.contactName && !isPlaceholder(client.contactName) ? client.contactName : ''
    const companyName = clean(args.companyName) || knownCompany || ''
    const signerName = clean(args.signerName) || knownContact || ''
    const signerEmail = clean(args.signerEmail) || client.email || ''
    const cnpj = clean(args.cnpj) || client.cnpj || ''

    // Required data BEFORE sending the contract (confirmed product rule).
    const missing: string[] = []
    if (!companyName) missing.push('razão social (nome da empresa)')
    if (!signerName) missing.push('nome completo do responsável que vai assinar')
    if (!signerEmail.includes('@')) missing.push('e-mail válido do assinante')
    if (!cnpj) missing.push('CNPJ da empresa')
    // Guard against the signer name being the same as the CNPJ/e-mail (means the
    // AI didn't actually collect a real person's name).
    if (signerName && (onlyDigits(signerName) === cnpj || signerName.includes('@'))) {
      if (!missing.includes('nome completo do responsável que vai assinar')) {
        missing.push('nome completo do responsável que vai assinar')
      }
    }
    if (missing.length) {
      return {
        ok: false,
        data: { missing },
        message: `Ainda NÃO posso enviar o contrato. Faltam dados REAIS do cliente: ${missing.join(', ')}. Peça esses dados ao cliente, UM por vez, e só chame esta ferramenta quando tiver TODOS preenchidos de verdade. NUNCA invente nem use "não informado". NÃO diga que enviou o contrato.`,
      }
    }

    // Persist the collected data on the client for future use.
    await db
      .update(clients)
      .set({
        companyName: companyName || client.companyName,
        contactName: signerName,
        email: signerEmail,
        cnpj: onlyDigits(cnpj),
        updatedAt: new Date(),
      })
      .where(eq(clients.id, ctx.clientId))

    // Create the contract row first (so we have an id), then try DocuSign.
    const [row] = await db
      .insert(contracts)
      .values({ clientId: ctx.clientId, quoteId: quote.id, status: 'created' })
      .returning()
    if (!row) return { ok: false, message: 'Falha ao criar o contrato.' }

    // Real DocuSign when configured; graceful placeholder otherwise.
    if (isDocusignConfigured()) {
      try {
        const { envelopeId, signingUrl } = await sendContractForSignature({
          signerName,
          signerEmail,
          clientUserId: client.id,
          companyName: companyName || client.companyName,
          cnpj: onlyDigits(cnpj),
          monthlyTotal: brl(Number(quote.monthlyTotal)),
          headcount: quote.headcount,
          returnUrl: env.DOCUSIGN_SIGN_RETURN_URL,
        })
        await db
          .update(contracts)
          .set({ status: 'sent', docusignEnvelopeId: envelopeId, signingUrl })
          .where(eq(contracts.id, row.id))
        return {
          ok: true,
          data: { contractId: row.id, envelopeId, signingUrl },
          message: `Contrato gerado via DocuSign. Envie ESTE link ao cliente para assinar:\n${signingUrl}\n\nPeça para ele assinar e AGUARDAR — assim que concluir, eu reconheço a assinatura automaticamente em poucos instantes e já gero o PIX. NÃO peça para o cliente avisar nem digitar nada.`,
        }
      } catch (err) {
        logger.error({ err }, 'DocuSign envelope failed; falling back to placeholder')
      }
    }

    const url = `https://app.alelo.local/sign/${row.id}` // placeholder until DocuSign credentials are set
    await db.update(contracts).set({ status: 'sent', signingUrl: url }).where(eq(contracts.id, row.id))
    return {
      ok: true,
      data: { contractId: row.id, signingUrl: url },
      message: `Contrato gerado. Link de assinatura (simulado até configurar DocuSign): ${url}`,
    }
  },

  async agendar_renovacao(args, ctx) {
    const days = Number(args.daysFromNow ?? 0)
    if (!days || days < 1) return { ok: false, message: 'daysFromNow inválido' }
    const when = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    await db.insert(notifications).values({
      clientId: ctx.clientId,
      kind: 'renewal',
      payload: { note: args.note ?? 'Lembrete de renovação de benefício.' },
      scheduledFor: when,
    })
    return { ok: true, message: `Renovação agendada para ${when.toLocaleDateString('pt-BR')}.` }
  },

  async escalar_humano(args, ctx) {
    const reason = String(args.reason ?? 'Solicitação do cliente')
    const summary = typeof args.summary === 'string' ? args.summary : reason
    // Auto-classify from the reason; let the AI override priority if it passed one.
    const auto = classify(reason)
    const priority = (
      ['low', 'medium', 'high', 'urgent'].includes(String(args.priority))
        ? args.priority
        : auto.priority
    ) as 'low' | 'medium' | 'high' | 'urgent'

    // There's always an active ticket (ensureTicket on inbound). Update it with
    // the escalation context, then route it to the human queue (auto-assign).
    const existing = await activeTicketForConversation(ctx.conversationId)
    const ticket =
      existing ??
      (await createTicket({
        clientId: ctx.clientId,
        conversationId: ctx.conversationId,
        subject: reason,
        reason,
        priority,
        category: auto.category,
        actor: 'ai',
      }))

    // Persist captured context + classification on the ticket so the human
    // starts informed.
    await db
      .update(tickets)
      .set({ subject: reason.slice(0, 140), reason, summary, priority, category: auto.category })
      .where(eq(tickets.id, ticket.id))

    // Route to the queue: sets handling_mode='human' and auto-assigns to an
    // online operator (least-loaded). Returns null if nobody online yet.
    const assignedTo = await routeToQueue(ticket.id, { actor: 'ai', note: reason })

    await db
      .update(conversations)
      .set({ status: 'waiting_human' })
      .where(eq(conversations.id, ctx.conversationId))
    bus.emitEvent({
      type: 'conversation.status',
      conversationId: ctx.conversationId,
      clientId: ctx.clientId,
      status: 'waiting_human',
    })

    return {
      ok: true,
      data: { escalated: true, ticketId: ticket.id, priority, category: auto.category, assignedTo },
      message:
        'Conversa escalada para atendimento humano. Avise o cliente, de forma breve, que um especialista assumirá em instantes.',
    }
  },

  async cadastrar_beneficiarios(args, ctx) {
    const list = Array.isArray(args.beneficiaries) ? args.beneficiaries : []
    const rows = list
      .map((b) => {
        const item = b as Record<string, unknown>
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        if (!name) return null
        const benefitType = (
          ['refeicao', 'alimentacao', 'mobilidade', 'multibeneficios'].includes(
            String(item.benefitType),
          )
            ? item.benefitType
            : 'refeicao'
        ) as BenefitType
        return {
          clientId: ctx.clientId,
          name,
          cpf: typeof item.cpf === 'string' ? onlyDigits(item.cpf) || null : null,
          benefitType,
          monthlyValue: item.monthlyValue != null ? String(item.monthlyValue) : null,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (rows.length === 0) return { ok: false, message: 'Nenhum beneficiário válido para cadastrar.' }

    await db.insert(beneficiaries).values(rows)

    // Keep the client headcount in sync with active beneficiaries.
    const active = await db
      .select()
      .from(beneficiaries)
      .where(and(eq(beneficiaries.clientId, ctx.clientId), eq(beneficiaries.active, true)))
    await db.update(clients).set({ headcount: active.length }).where(eq(clients.id, ctx.clientId))

    return {
      ok: true,
      data: { cadastrados: rows.length, totalAtivos: active.length },
      message: `${rows.length} colaborador(es) cadastrado(s). Total ativo na conta: ${active.length}.`,
    }
  },

  async gerenciar_conta(args, ctx) {
    const updates: Record<string, unknown> = {}
    if (typeof args.companyName === 'string' && args.companyName.trim())
      updates.companyName = args.companyName.trim()
    if (typeof args.cnpj === 'string') updates.cnpj = onlyDigits(args.cnpj)
    if (typeof args.contactName === 'string') updates.contactName = args.contactName
    if (typeof args.email === 'string') updates.email = args.email

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date()
      await db.update(clients).set(updates).where(eq(clients.id, ctx.clientId))
    }

    let deactivated = 0
    let askedToDeactivate = false
    if (typeof args.deactivateBeneficiaryName === 'string' && args.deactivateBeneficiaryName.trim()) {
      askedToDeactivate = true
      const target = args.deactivateBeneficiaryName.trim().toLowerCase()
      const all = await db
        .select()
        .from(beneficiaries)
        .where(eq(beneficiaries.clientId, ctx.clientId))
      for (const b of all) {
        if (b.active && b.name.toLowerCase().includes(target)) {
          await db.update(beneficiaries).set({ active: false }).where(eq(beneficiaries.id, b.id))
          deactivated++
        }
      }
      if (deactivated > 0) {
        const active = await db
          .select()
          .from(beneficiaries)
          .where(and(eq(beneficiaries.clientId, ctx.clientId), eq(beneficiaries.active, true)))
        await db.update(clients).set({ headcount: active.length }).where(eq(clients.id, ctx.clientId))
      }
    }

    // Honesty guard: if the user asked to deactivate someone who isn't in the
    // account, say so plainly — never claim success.
    if (askedToDeactivate && deactivated === 0) {
      return {
        ok: false,
        data: { notFound: args.deactivateBeneficiaryName },
        message: `Não encontrei "${args.deactivateBeneficiaryName}" entre os colaboradores ativos desta conta. Informe ao cliente que esse nome não está cadastrado e peça o nome exato. NÃO afirme que foi desativado.`,
      }
    }

    if (Object.keys(updates).length === 0 && deactivated === 0) {
      return { ok: false, message: 'Nada para atualizar.' }
    }
    return {
      ok: true,
      data: { atualizados: Object.keys(updates).filter((k) => k !== 'updatedAt'), desativados: deactivated },
      message: `Conta atualizada com sucesso.${deactivated > 0 ? ` ${deactivated} colaborador(es) desativado(s).` : ''}`,
    }
  },

  async enviar_nps(_args, ctx) {
    // Don't double-send: if a survey is already pending (sent, not answered) for
    // the active ticket, reuse it instead of inserting a second row.
    const active = await activeTicketForConversation(ctx.conversationId)
    const existing = (
      await db
        .select()
        .from(npsResponses)
        .where(eq(npsResponses.clientId, ctx.clientId))
        .orderBy(desc(npsResponses.sentAt))
        .limit(1)
    )[0]
    let row = existing && existing.answeredAt == null && existing.score == null ? existing : undefined
    if (!row) {
      row = (
        await db
          .insert(npsResponses)
          .values({ clientId: ctx.clientId, ticketId: active?.id ?? null })
          .returning()
      )[0]
    }
    // IMPORTANT: do NOT resolve the ticket here. The attendance only ends once the
    // client actually answers the score — captured in the inbound handler, which
    // then resolves the ticket. Resolving now would (a) lose the score and
    // (b) make the client's score reply spawn a brand-new duplicate ticket.
    return {
      ok: true,
      data: { npsId: row?.id },
      message:
        'Pergunte ao cliente, de 0 a 10, o quanto ele recomendaria a Alelo a um colega de RH. Avise que após a nota o atendimento será encerrado. (A nota é registrada automaticamente quando ele responder.)',
    }
  },

  async gerar_pagamento_pix(args, ctx) {
    const value = typeof args.value === 'number' ? args.value : undefined
    const description = typeof args.description === 'string' ? args.description : undefined
    const r = await createAndSendPix(ctx.clientId, { value, description })
    if (!r.ok) return { ok: false, message: r.message }
    return {
      ok: true,
      data: { chargeId: r.chargeId, value: r.value },
      message: `Enviei o PIX de ${brl(r.value ?? 0)} ao cliente (QR Code + código copia e cola). Avise que é só pagar e a confirmação chega automaticamente.`,
    }
  },

  async ativar_cobranca_mensal(args, ctx) {
    if (!isAsaasConfigured()) {
      return { ok: false, message: 'Cobrança recorrente indisponível: Asaas não configurado.' }
    }
    const [client] = await db.select().from(clients).where(eq(clients.id, ctx.clientId))
    if (!client) return { ok: false, message: 'Cliente não encontrado.' }

    let value = Number(args.value ?? 0)
    if (!value || value <= 0) {
      const qs = await db.select().from(quotes).where(eq(quotes.clientId, ctx.clientId))
      const last = qs.at(-1)
      value = last ? Number(last.monthlyTotal) : 0
    }
    if (!value || value <= 0) {
      return { ok: false, message: 'Sem valor mensal. Faça uma cotação antes ou informe o valor.' }
    }

    // Auto-detect: if the client ALREADY paid a charge this calendar month
    // (e.g. the avulsa just paid), the recurrence must start NEXT month so we
    // never charge twice in the same month. Don't rely on the AI to pass the
    // flag — decide it from the real payment history.
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const paidThisMonth = await db
      .select({ id: pixCharges.id })
      .from(pixCharges)
      .where(
        and(
          eq(pixCharges.clientId, ctx.clientId),
          sql`${pixCharges.paidAt} is not null`,
          sql`${pixCharges.paidAt} >= ${monthStart.toISOString()}`,
        ),
      )
      .limit(1)
    const startNextMonth = args.startNextMonth === true || paidThisMonth.length > 0

    let sub
    let firstCharge
    try {
      sub = await createMonthlySubscription({
        customer: {
          name: client.contactName || client.companyName,
          cpfCnpj: client.cnpj || undefined,
          email: client.email || undefined,
          phone: client.phone,
        },
        value,
        description: `Mensalidade Alelo - ${client.companyName}`,
        externalReference: `client:${client.id}`,
        dueDay: typeof args.dueDay === 'number' ? args.dueDay : undefined,
        startNextMonth,
      })
      // When recurring starts next month (already paid this month), don't
      // fetch/send a charge now — there's nothing due this cycle.
      firstCharge = startNextMonth ? null : await getSubscriptionLatestCharge(sub.id)
    } catch (err) {
      logger.error({ err }, 'Falha ao criar assinatura mensal')
      return { ok: false, message: 'Não consegui ativar a cobrança mensal agora. Tente novamente.' }
    }

    await db.insert(subscriptions).values({
      clientId: ctx.clientId,
      asaasSubscriptionId: sub.id,
      status: sub.status,
      value: String(sub.value),
      cycle: 'MONTHLY',
      description: `Mensalidade Alelo - ${client.companyName}`,
      nextDueDate: sub.nextDueDate ? new Date(sub.nextDueDate) : null,
    })

    // Resolve our subscription row id so the first charge is linked to it (the
    // confirm message + UI then treat it as a mensalidade, not a setup payment).
    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.asaasSubscriptionId, sub.id))

    if (firstCharge) {
      await db.insert(pixCharges).values({
        clientId: ctx.clientId,
        asaasPaymentId: firstCharge.id,
        subscriptionId: subRow?.id ?? null,
        status: firstCharge.status,
        value: String(firstCharge.value),
        description: `Mensalidade Alelo - ${client.companyName}`,
        copyPaste: firstCharge.pixCopyPaste,
      })
      try {
        await notifyImage(
          ctx.clientId,
          firstCharge.pixQrCodeBase64,
          `*Mensalidade Alelo - ${brl(value)}/mês*\nAtivei sua cobrança mensal automática. Pague a 1ª via abaixo; todo mês eu te envio o novo PIX por aqui. 👇`,
        )
        await notifyText(ctx.clientId, firstCharge.pixCopyPaste)
      } catch (err) {
        logger.error({ err }, 'Falha ao enviar 1ª via da mensalidade')
      }
    }

    return {
      ok: true,
      data: { subscriptionId: sub.id, value, nextDueDate: sub.nextDueDate, startNextMonth },
      message: startNextMonth
        ? `Recorrência de ${brl(value)}/mês ativada. Como o cliente JÁ pagou este mês, NÃO foi gerada nenhuma cobrança nova agora — a 1ª cobrança automática será em ${sub.nextDueDate}. Avise que está tudo certo, que NADA precisa ser pago de novo agora, e que todo mês o PIX chega por aqui com lembrete antes do vencimento.`
        : `Cobrança mensal de ${brl(value)} ativada (próximo vencimento ${sub.nextDueDate}). Enviei a 1ª via por PIX ao cliente; as próximas saem automaticamente todo mês.`,
    }
  },

  async confirmar_assinatura(_args, ctx) {
    const ctr = await db
      .select()
      .from(contracts)
      .where(eq(contracts.clientId, ctx.clientId))
      .orderBy(desc(contracts.createdAt))
    const contract = ctr.find((c) => c.status !== 'signed') ?? ctr[0]
    if (!contract) {
      return {
        ok: false,
        message: 'Não há contrato para confirmar. Gere a assinatura primeiro com iniciar_assinatura.',
      }
    }
    if (contract.status !== 'signed') {
      await db
        .update(contracts)
        .set({ status: 'signed', signedAt: new Date() })
        .where(eq(contracts.id, contract.id))
    }
    await advanceStage(ctx.clientId, 'active')
    // Payment is the next system step — generate + send the PIX now.
    const pix = await createAndSendPix(ctx.clientId)
    return {
      ok: true,
      data: { contractId: contract.id, pixOk: pix.ok },
      message: pix.ok
        ? `Assinatura confirmada! Já enviei o PIX do pagamento ao cliente (${pix.message}). Avise que é só pagar — a confirmação chega sozinha.`
        : 'Assinatura confirmada! Porém não consegui gerar o PIX agora; tente gerar_pagamento_pix.',
    }
  },
}
