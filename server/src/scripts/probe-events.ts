/** Probe determinístico: toda transição precisa gerar 1 evento de auditoria. */
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, conversations, ticketEvents } from '../db/schema.js'
import { createTicket, transitionTicket } from '../domain/ticket-service.js'

async function main() {
  const phone = '5511955559999'
  await db.delete(clients).where(eq(clients.phone, phone))
  const [client] = await db.insert(clients).values({ phone, companyName: 'Probe', stage: 'active' }).returning()
  const [convo] = await db.insert(conversations).values({ clientId: client!.id, status: 'waiting_human' }).returning()

  const t = await createTicket({ clientId: client!.id, conversationId: convo!.id, subject: 'probe', actor: 'ai' })
  await transitionTicket(t.id, 'pending', { actor: 'operator:x' })
  await transitionTicket(t.id, 'resolved', { actor: 'operator:x' })
  await transitionTicket(t.id, 'open', { actor: 'client' }) // reopen
  await transitionTicket(t.id, 'closed', { actor: 'operator:x' })

  const events = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, t.id)).orderBy(ticketEvents.createdAt)
  console.log(`total de eventos: ${events.length} (esperado: 5)`)
  for (const e of events) console.log(`  ${e.type} ${e.fromStatus ?? ''}→${e.toStatus ?? ''} · ${e.actor}`)

  const ok = events.length === 5
  await db.delete(clients).where(eq(clients.phone, phone))
  console.log(ok ? 'PASS — auditoria completa' : 'FALHOU — faltam eventos')
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
