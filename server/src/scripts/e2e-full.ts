/**
 * Full conversation E2E: quote -> accept -> sign (DocuSign placeholder) ->
 * escalate to human -> ticket. Validates the whole tool surface + persistence.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, contracts, conversations, quotes, tickets } from '../db/schema.js'
import { resolveModel } from '../ai/openai.js'
import { runAgentTurn } from '../ai/agent.js'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

async function main() {
  await resolveModel()
  const phone = '5511970001122'
  await db.delete(clients).where(eq(clients.phone, phone))
  const [client] = await db
    .insert(clients)
    .values({ phone, companyName: 'Indústria Beta', contactName: 'Marcos', email: 'marcos@beta.com', stage: 'lead' })
    .returning()
  const [convo] = await db.insert(conversations).values({ clientId: client!.id, status: 'bot' }).returning()
  const ctx = { clientId: client!.id, conversationId: convo!.id }

  const history: ChatCompletionMessageParam[] = []
  const say = async (text: string, label: string) => {
    history.push({ role: 'user', content: text })
    const r = await runAgentTurn(history, ctx)
    history.push({ role: 'assistant', content: r.text })
    console.log(`\n>>> ${label}: "${text}"`)
    console.log(`tools: [${r.toolsUsed.join(', ')}]`)
    console.log(`bot: ${r.text.slice(0, 200)}`)
    return r
  }

  await say('Oi, quero cotar vale refeição para 200 colaboradores', 'cotar')
  await say('Perfeito, pode seguir com a assinatura do contrato', 'assinar')
  await say('Na verdade preciso falar com um atendente humano sobre uma condição especial', 'escalar')

  const q = await db.select().from(quotes).where(eq(quotes.clientId, client!.id))
  const c = await db.select().from(contracts).where(eq(contracts.clientId, client!.id))
  const t = await db.select().from(tickets).where(eq(tickets.clientId, client!.id))
  const [conv2] = await db.select().from(conversations).where(eq(conversations.id, convo!.id))

  console.log('\n===== ESTADO FINAL =====')
  console.log('cotações:', q.length, q[0] ? `(R$ ${q[0].monthlyTotal}/mês, ${q[0].headcount} colab.)` : '')
  console.log('contratos:', c.length, c[0] ? `(status=${c[0].status}, url=${c[0].signingUrl?.slice(0, 40)}...)` : '')
  console.log('tickets:', t.length, t[0] ? `(prio=${t[0].priority}, status=${t[0].status})` : '')
  console.log('conversa status:', conv2?.status)

  const ok =
    q.length > 0 &&
    c.length > 0 &&
    t.length > 0 &&
    conv2?.status === 'waiting_human'
  console.log('\nRESULTADO:', ok ? 'PASS ✔ (cotação + contrato + ticket + escalada)' : 'FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('ERRO:', e)
  process.exit(2)
})
