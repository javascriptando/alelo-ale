/**
 * Simula conversas reais com a IA, em vários cenários, mostrando EXATAMENTE o
 * que ela responde e quais ferramentas usa — sem gastar o WhatsApp.
 * Cada cenário usa um cliente/conversa isolado (telefone fake).
 *
 * Rodar: npx tsx src/scripts/sim-conversations.ts
 */
import { eq } from 'drizzle-orm'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { db } from '../db/index.js'
import { beneficiaries, clients, contracts, conversations, npsResponses, quotes, tickets } from '../db/schema.js'
import { resolveModel } from '../ai/openai.js'
import { runAgentTurn } from '../ai/agent.js'

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m', bold: '\x1b[1m' }

async function freshClient(phone: string, name: string) {
  await db.delete(clients).where(eq(clients.phone, phone))
  const [client] = await db
    .insert(clients)
    .values({ phone, companyName: name, stage: 'lead' })
    .returning()
  const [convo] = await db.insert(conversations).values({ clientId: client!.id, status: 'bot' }).returning()
  return { clientId: client!.id, conversationId: convo!.id }
}

async function runScenario(title: string, phone: string, company: string, turns: string[]) {
  console.log(`\n${C.bold}${C.cyan}━━━ CENÁRIO: ${title} ━━━${C.reset}`)
  const ctx = await freshClient(phone, company)
  const history: ChatCompletionMessageParam[] = []
  for (const userMsg of turns) {
    history.push({ role: 'user', content: userMsg })
    const r = await runAgentTurn(history, ctx)
    history.push({ role: 'assistant', content: r.text })
    console.log(`\n${C.yellow}👤 Cliente:${C.reset} ${userMsg}`)
    if (r.toolsUsed.length) console.log(`${C.gray}   ⚙ tools: ${r.toolsUsed.join(', ')}${C.reset}`)
    console.log(`${C.green}🤖 IA:${C.reset} ${r.text}`)
  }
  // dump final DB state for this client
  const q = await db.select().from(quotes).where(eq(quotes.clientId, ctx.clientId))
  const c = await db.select().from(contracts).where(eq(contracts.clientId, ctx.clientId))
  const t = await db.select().from(tickets).where(eq(tickets.clientId, ctx.clientId))
  const b = await db.select().from(beneficiaries).where(eq(beneficiaries.clientId, ctx.clientId))
  const n = await db.select().from(npsResponses).where(eq(npsResponses.clientId, ctx.clientId))
  console.log(
    `${C.gray}   📊 estado: cotações=${q.length} contratos=${c.length} tickets=${t.length} beneficiários=${b.length} nps=${n.length}${C.reset}`,
  )
}

async function main() {
  const model = await resolveModel()
  console.log(`${C.bold}Modelo: ${model}${C.reset}`)

  await runScenario('Jornada completa (cotar → assinar → cadastrar → NPS)', '5511900000001', 'Tech Solutions', [
    'Oi, tudo bem?',
    'Quero contratar vale refeição para minha empresa, temos 120 funcionários',
    'Pode seguir com a assinatura',
    'Quero cadastrar os colaboradores: Ana Silva, Bruno Costa e Carla Dias',
    'Obrigado, era só isso, ficou ótimo o atendimento!',
  ])

  await runScenario('Cliente indeciso / pede detalhes', '5511900000002', 'Padaria Pão Quente', [
    'oi, queria entender como funciona o benefício de vocês',
    'somos uma empresa pequena, uns 8 funcionários',
  ])

  await runScenario('Reclamação → escala humano', '5511900000003', 'Construtora Forte', [
    'estou MUITO insatisfeito, meus cartões não chegaram e ninguém resolve',
  ])

  await runScenario('Fora de escopo', '5511900000004', 'Curiosa Ltda', [
    'vocês fazem empréstimo consignado também?',
  ])

  await runScenario('Gestão de conta (desativar colaborador)', '5511900000005', 'Mercado Central', [
    'preciso cadastrar 50 funcionários no vale alimentação',
    'o funcionário João Pereira saiu da empresa, pode desativar ele?',
  ])

  console.log(`\n${C.bold}${C.green}✓ Simulação concluída.${C.reset}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('ERRO:', e)
  process.exit(1)
})
