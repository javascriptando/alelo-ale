/** Verifica que a Alê se apresenta SÓ na 1ª mensagem. */
import { eq } from 'drizzle-orm'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { db } from '../db/index.js'
import { clients, conversations } from '../db/schema.js'
import { resolveModel } from '../ai/openai.js'
import { runAgentTurn } from '../ai/agent.js'

async function main() {
  await resolveModel()
  const phone = '5511933330000'
  await db.delete(clients).where(eq(clients.phone, phone))
  const [client] = await db.insert(clients).values({ phone, companyName: 'Teste Nome', stage: 'lead' }).returning()
  const [convo] = await db.insert(conversations).values({ clientId: client!.id, status: 'bot' }).returning()
  const ctx = { clientId: client!.id, conversationId: convo!.id }
  const history: ChatCompletionMessageParam[] = []

  const turns = ['Olá, tudo bem?', 'São 230 pessoas', 'Quero', 'pode cadastrar a Maria Silva']
  let intros = 0
  for (const msg of turns) {
    history.push({ role: 'user', content: msg })
    const r = await runAgentTurn(history, ctx)
    history.push({ role: 'assistant', content: r.text })
    const introduces = /sou a \*?alê|eu sou a alê|alê, da alelo/i.test(r.text)
    if (introduces) intros++
    console.log(`\n👤 ${msg}`)
    console.log(`🤖 ${r.text.slice(0, 110)}${r.text.length > 110 ? '…' : ''}`)
    console.log(`   ${introduces ? '⚠ apresentou-se' : '✓ sem apresentação'}`)
  }
  await db.delete(clients).where(eq(clients.phone, phone))
  console.log(`\n${intros === 1 ? '✓ PASS' : '✗ FALHOU'} — apresentações: ${intros} (esperado: 1, só na 1ª)`)
  process.exit(intros === 1 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
