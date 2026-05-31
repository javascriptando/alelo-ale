import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { beneficiaries, clients, contracts, messages, quotes } from '../db/schema.js'
import { openai, resolveModel } from './openai.js'
import { logger } from '../config/logger.js'

export interface Suggestion {
  text: string
  tone: string // e.g. "empático", "objetivo", "resolutivo"
}

const SYSTEM = `Você é a *Alê*, a IA copiloto interna da Alelo, ajudando um ATENDENTE HUMANO a responder um cliente (RH de empresa) no WhatsApp.

Sua tarefa: ler o histórico da conversa e os dados da conta e propor de 2 a 3 respostas curtas, prontas para o atendente enviar (ele pode editar antes). NÃO fale com o cliente diretamente; você escreve o que o ATENDENTE diria.

Regras:
- Português brasileiro, tom profissional e cordial, mensagens curtas (WhatsApp).
- Cada sugestão deve ser autossuficiente e acionável.
- Varie o ângulo: ex. uma mais empática, uma mais objetiva/resolutiva, uma que peça a informação que falta.
- Use os dados da conta quando ajudarem (nome da empresa, contratos, cotações, beneficiários).
- Nunca invente valores, prazos ou políticas que não estejam nos dados. Se faltar info, sugira pedir ao cliente.
- Responda SOMENTE em JSON válido no formato: {"suggestions":[{"text":"...","tone":"..."}]}`

async function buildContext(clientId: string): Promise<string> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId))
  const q = await db
    .select()
    .from(quotes)
    .where(eq(quotes.clientId, clientId))
    .orderBy(desc(quotes.createdAt))
    .limit(3)
  const c = await db.select().from(contracts).where(eq(contracts.clientId, clientId))
  const benef = await db
    .select()
    .from(beneficiaries)
    .where(and(eq(beneficiaries.clientId, clientId), eq(beneficiaries.active, true)))

  return JSON.stringify({
    empresa: client?.companyName,
    contato: client?.contactName,
    estagio: client?.stage,
    cotacoes: q.map((x) => ({ headcount: x.headcount, totalMensal: x.monthlyTotal, status: x.status })),
    contratos: c.map((x) => ({ status: x.status, assinadoEm: x.signedAt })),
    beneficiariosAtivos: benef.length,
  })
}

/**
 * Generates suggested replies for the operator handling `conversationId`.
 * Read-only: never sends a message, never calls tools.
 */
export async function suggestReplies(
  conversationId: string,
  clientId: string,
): Promise<Suggestion[]> {
  const model = await resolveModel()

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(16)
  rows.reverse()

  const history: ChatCompletionMessageParam[] = rows.map((m) => {
    if (m.role === 'client') return { role: 'user', content: m.content }
    // bot/operator/system are all "our side" from the copilot's perspective
    return { role: 'assistant', content: `[${m.role}] ${m.content}` }
  })

  const context = await buildContext(clientId)

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'system', content: `Dados da conta:\n${context}` },
        ...history,
        {
          role: 'user',
          content:
            'Gere as sugestões de resposta para o atendente, considerando a última mensagem do cliente.',
        },
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' },
    })

    const raw = completion.choices[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(raw) as { suggestions?: Suggestion[] }
    const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    return list
      .filter((s) => s && typeof s.text === 'string' && s.text.trim())
      .slice(0, 3)
      .map((s) => ({ text: s.text.trim(), tone: s.tone || 'sugestão' }))
  } catch (err) {
    logger.error({ err, conversationId }, 'Falha ao gerar sugestões')
    return []
  }
}
