/**
 * Simula o novo modelo de fila/atribuição end-to-end (gateway fake, sem WhatsApp):
 *  1. Toda conversa vira ticket desde a 1ª msg (handlingMode='ai', lista "Com a Alê")
 *  2. Cliente pede humano → escalar_humano → ticket vai p/ fila e é auto-atribuído
 *     ao operador online menos carregado
 *  3. Distribuição justa entre 2 operadores online
 *  4. Ninguém online → fica sem atribuir; ao "logar", drainQueue distribui
 *  5. Operador devolve para a Alê (return-to-ai)
 *  6. Finalizar (closed) → próxima msg do cliente é CONVERSA NOVA (novo ticket)
 *
 * Rodar: npx tsx src/scripts/sim-queue.ts
 */
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, conversations, operators, tickets } from '../db/schema.js'
import { resolveModel } from '../ai/openai.js'
import { makeInboundHandler } from '../domain/conversation-service.js'
import { activeTicketForConversation } from '../domain/ticket-service.js'
import { drainQueue, routeToQueue, touchPresence } from '../domain/assignment-service.js'
import type { WhatsAppGateway, InboundHandler } from '../whatsapp/gateway.js'

const C = { r: '\x1b[0m', c: '\x1b[36m', g: '\x1b[32m', y: '\x1b[33m', gray: '\x1b[90m', b: '\x1b[1m', red: '\x1b[31m' }
const sent: { phone: string; text: string }[] = []
class FakeGateway implements WhatsAppGateway {
  h: InboundHandler | null = null
  async start() {}
  isReady() { return true }
  onMessage(h: InboundHandler) { this.h = h }
  async sendText(phone: string, text: string) { sent.push({ phone, text }) }
}

async function setOffline(id: string) {
  await db.update(operators).set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }).where(eq(operators.id, id))
}
async function nameOf(id: string | null) {
  if (!id) return '(ninguém)'
  const [o] = await db.select().from(operators).where(eq(operators.id, id))
  return o?.name ?? id
}

async function main() {
  await resolveModel()
  const gateway = new FakeGateway()
  const inbound = makeInboundHandler(gateway)
  const phone = '5511944440000'

  // operadores de teste (além dos seed): garantir 2 operadores não-admin
  const ops = await db.select().from(operators).where(sql`${operators.role} <> 'admin'`)
  const [op1, op2] = ops
  if (!op1 || !op2) throw new Error('Precisa de ao menos 2 operadores não-admin (rode db:seed)')

  // todos offline no começo
  for (const o of ops) await setOffline(o.id)
  await db.delete(clients).where(eq(clients.phone, phone))

  let pass = true
  const check = (label: string, cond: boolean) => {
    console.log(`   ${cond ? C.g + '✓' : C.red + '✗'} ${label}${C.r}`)
    if (!cond) pass = false
  }

  // ── 1) primeira msg → ticket AI ──────────────────────────
  console.log(`${C.b}${C.c}━━ 1) 1ª msg vira ticket (handlingMode=ai) ━━${C.r}`)
  await inbound({ from: `${phone}@s.whatsapp.net`, phone, pushName: 'Diego', text: 'Olá, quero cotar para 50 pessoas', waMessageId: 'q1', timestamp: Date.now() })
  const [client] = await db.select().from(clients).where(eq(clients.phone, phone))
  const t1 = await activeTicketForConversation((await db.select().from(conversations).where(eq(conversations.clientId, client!.id)))[0]!.id)
  console.log(`   bot: ${sent.at(-1)?.text.slice(0, 60)}…`)
  check('existe ticket ativo', !!t1)
  check("handlingMode = 'ai'", t1?.handlingMode === 'ai')

  // ── 2) cliente pede humano, 1 operador online ────────────
  console.log(`\n${C.b}${C.c}━━ 2) cliente pede humano (op1 online) → auto-atribui ━━${C.r}`)
  await touchPresence(op1.id) // op1 online
  await inbound({ from: `${phone}@s.whatsapp.net`, phone, pushName: 'Diego', text: 'Quero falar com um atendente humano, por favor', waMessageId: 'q2', timestamp: Date.now() })
  const t2 = await activeTicketForConversation(t1!.conversationId!)
  console.log(`   ${C.gray}atribuído a: ${await nameOf(t2?.assignedOperatorId ?? null)} | mode=${t2?.handlingMode}${C.r}`)
  check("handlingMode = 'human'", t2?.handlingMode === 'human')
  check('atribuído ao op1 (único online)', t2?.assignedOperatorId === op1.id)
  check('resumo capturado p/ humano', !!t2?.summary)

  // ── 3) distribuição justa entre 2 online ─────────────────
  console.log(`\n${C.b}${C.c}━━ 3) 2 operadores online → distribuição justa ━━${C.r}`)
  await touchPresence(op1.id); await touchPresence(op2.id)
  // cria 4 novos clientes que escalam direto; conta quem recebeu
  const counts: Record<string, number> = { [op1.id]: 1 } // op1 já tem 1 do passo 2
  for (let i = 0; i < 4; i++) {
    const p = `551193333000${i}`
    await db.delete(clients).where(eq(clients.phone, p))
    const [cl] = await db.insert(clients).values({ phone: p, companyName: `T${i}`, stage: 'lead' }).returning()
    const [cv] = await db.insert(conversations).values({ clientId: cl!.id, status: 'bot' }).returning()
    const [tk] = await db.insert(tickets).values({ clientId: cl!.id, conversationId: cv!.id, subject: 'x', status: 'open', handlingMode: 'ai' }).returning()
    const assigned = await routeToQueue(tk!.id, { actor: 'ai' })
    if (assigned) counts[assigned] = (counts[assigned] ?? 0) + 1
  }
  console.log(`   ${C.gray}op1=${counts[op1.id] ?? 0} | op2=${counts[op2.id] ?? 0} (5 tickets no total)${C.r}`)
  const balanced = Math.abs((counts[op1.id] ?? 0) - (counts[op2.id] ?? 0)) <= 1
  check('carga equilibrada (diferença ≤ 1)', balanced)

  // ── 4) ninguém online → fica na fila; loga → drena ───────
  console.log(`\n${C.b}${C.c}━━ 4) ninguém online → fila; operador loga → drena ━━${C.r}`)
  for (const o of ops) await setOffline(o.id)
  const p5 = '5511922220000'
  await db.delete(clients).where(eq(clients.phone, p5))
  const [cl5] = await db.insert(clients).values({ phone: p5, companyName: 'SemOp', stage: 'lead' }).returning()
  const [cv5] = await db.insert(conversations).values({ clientId: cl5!.id, status: 'bot' }).returning()
  const [tk5] = await db.insert(tickets).values({ clientId: cl5!.id, conversationId: cv5!.id, subject: 'fila', status: 'open', handlingMode: 'ai' }).returning()
  const a5 = await routeToQueue(tk5!.id, { actor: 'ai' })
  check('sem operador online → não atribui', a5 === null)
  await touchPresence(op2.id) // op2 loga
  const drained = await drainQueue()
  const [tk5b] = await db.select().from(tickets).where(eq(tickets.id, tk5!.id))
  console.log(`   ${C.gray}drenados=${drained} | agora atribuído a: ${await nameOf(tk5b?.assignedOperatorId ?? null)}${C.r}`)
  check('após login, fila drena p/ op2', tk5b?.assignedOperatorId === op2.id)

  // ── 5) finalizar → nova msg = nova conversa ──────────────
  console.log(`\n${C.b}${C.c}━━ 5) finalizar ticket → próxima msg vira conversa NOVA ━━${C.r}`)
  const { transitionTicket } = await import('../domain/ticket-service.js')
  await transitionTicket(t2!.id, 'resolved', { actor: 'operator:test' })
  await transitionTicket(t2!.id, 'closed', { actor: 'operator:test' })
  const [convClosed] = await db.select().from(conversations).where(eq(conversations.id, t2!.conversationId!))
  check('conversa fechada ao finalizar', convClosed?.status === 'closed')
  await inbound({ from: `${phone}@s.whatsapp.net`, phone, pushName: 'Diego', text: 'Oi, tenho outra dúvida', waMessageId: 'q3', timestamp: Date.now() })
  const convos = await db.select().from(conversations).where(eq(conversations.clientId, client!.id))
  const newTicket = await activeTicketForConversation(convos.find((c) => c.status !== 'closed')!.id)
  check('criou conversa nova (2 conversas no cliente)', convos.length === 2)
  check('novo ticket != ticket finalizado', !!newTicket && newTicket.id !== t2!.id)

  // limpeza
  await db.delete(clients).where(eq(clients.phone, phone))
  for (let i = 0; i < 4; i++) await db.delete(clients).where(eq(clients.phone, `551193333000${i}`))
  await db.delete(clients).where(eq(clients.phone, p5))

  console.log(`\n${pass ? C.g + C.b + '✓ PASS — modelo de fila/atribuição OK' : C.red + C.b + '✗ FALHOU'}${C.r}`)
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error('ERRO:', e); process.exit(2) })
