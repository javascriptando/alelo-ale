/**
 * Smoke test the AI agent end-to-end against the real OpenAI API and DB.
 * Creates a throwaway client+conversation, runs a turn that should trigger a
 * quote tool call, and prints what happened. Run: npx tsx src/scripts/test-agent.ts
 */
import { db } from '../db/index.js'
import { clients, conversations, quotes } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { resolveModel } from '../ai/openai.js'
import { runAgentTurn } from '../ai/agent.js'

async function main() {
  const model = await resolveModel()
  console.log('Modelo selecionado:', model)

  const phone = '5511999990000'
  await db.delete(clients).where(eq(clients.phone, phone)) // clean slate (cascades)
  const [client] = await db
    .insert(clients)
    .values({ phone, companyName: 'Empresa Teste E2E', contactName: 'Joana RH', stage: 'lead' })
    .returning()
  const [convo] = await db
    .insert(conversations)
    .values({ clientId: client!.id, status: 'bot' })
    .returning()

  const ctx = { clientId: client!.id, conversationId: convo!.id }

  const turn1 = await runAgentTurn(
    [{ role: 'user', content: 'Oi! Sou do RH. Quero cotar vale refeição para 80 funcionários.' }],
    ctx,
  )
  console.log('\n--- TURNO 1 ---')
  console.log('tools:', turn1.toolsUsed)
  console.log('resposta:', turn1.text)

  const createdQuotes = await db.select().from(quotes).where(eq(quotes.clientId, client!.id))
  console.log('\nCotações criadas no banco:', createdQuotes.length)
  if (createdQuotes[0]) {
    console.log('  total mensal:', createdQuotes[0].monthlyTotal, 'headcount:', createdQuotes[0].headcount)
  }

  const ok = turn1.toolsUsed.includes('calcular_cotacao') && createdQuotes.length > 0
  console.log('\nRESULTADO:', ok ? 'PASS ✔ (IA cotou e persistiu)' : 'CHECK — IA não cotou nesta tentativa')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO:', err)
  process.exit(2)
})
