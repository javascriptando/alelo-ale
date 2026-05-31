/** Re-testa só o caso da desativação de quem não existe (honestidade). */
import { eq } from 'drizzle-orm'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { db } from '../db/index.js'
import { clients, conversations } from '../db/schema.js'
import { resolveModel } from '../ai/openai.js'
import { runAgentTurn } from '../ai/agent.js'

async function main() {
  await resolveModel()
  const phone = '5511900000099'
  await db.delete(clients).where(eq(clients.phone, phone))
  const [client] = await db
    .insert(clients)
    .values({ phone, companyName: 'Teste Honestidade', stage: 'active' })
    .returning()
  const [convo] = await db.insert(conversations).values({ clientId: client!.id, status: 'bot' }).returning()
  const ctx = { clientId: client!.id, conversationId: convo!.id }

  const history: ChatCompletionMessageParam[] = []
  const msg = 'pode desativar o funcionário João Pereira? ele saiu da empresa'
  history.push({ role: 'user', content: msg })
  const r = await runAgentTurn(history, ctx)
  console.log('\n👤', msg)
  console.log('⚙ tools:', r.toolsUsed.join(', ') || '(nenhuma)')
  console.log('🤖', r.text)

  // limpa o cliente de teste
  await db.delete(clients).where(eq(clients.phone, phone))
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
