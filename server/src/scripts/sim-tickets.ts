/**
 * Simulação focada no ciclo de vida do ticket:
 *  - IA escala → ticket aberto (com prioridade/categoria automáticas)
 *  - operador recebe sugestões da IA, responde (open→pending), resolve
 *  - cliente volta dentro da janela → ticket REABRE com contexto
 *  - sugestões da IA consideram o histórico do ticket
 *  - transição inválida é rejeitada
 *
 * Usa um gateway fake (não dispara WhatsApp real). Limpa tudo ao final.
 * Rodar: npx tsx src/scripts/sim-tickets.ts
 */
import { eq } from 'drizzle-orm'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { db } from '../db/index.js'
import { clients, conversations, tickets, ticketEvents, messages } from '../db/schema.js'
import { resolveModel } from '../ai/openai.js'
import { runAgentTurn } from '../ai/agent.js'
import { suggestReplies } from '../ai/suggest.js'
import {
  activeTicketForConversation,
  canTransition,
  classify,
  latestTicket,
  transitionTicket,
} from '../domain/ticket-service.js'
import { makeInboundHandler, sendOperatorReply } from '../domain/conversation-service.js'
import type { WhatsAppGateway, InboundHandler } from '../whatsapp/gateway.js'

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m', bold: '\x1b[1m', red: '\x1b[31m' }
const sent: { phone: string; text: string }[] = []

// Fake gateway: records outbound, never touches WhatsApp.
class FakeGateway implements WhatsAppGateway {
  handler: InboundHandler | null = null
  async start() {}
  isReady() { return true }
  onMessage(h: InboundHandler) { this.handler = h }
  async sendText(phone: string, text: string) { sent.push({ phone, text }) }
}

async function main() {
  const model = await resolveModel()
  console.log(`${C.bold}Modelo: ${model}${C.reset}\n`)

  const gateway = new FakeGateway()
  const inbound = makeInboundHandler(gateway)
  const phone = '5511955550001'

  // limpa cliente
  await db.delete(clients).where(eq(clients.phone, phone))

  // ── 1) Cliente reclama (deve escalar e abrir ticket) ──────
  console.log(`${C.cyan}${C.bold}━━ 1) Cliente reclama → IA escala e abre ticket ━━${C.reset}`)
  await inbound({
    from: `${phone}@s.whatsapp.net`, phone, pushName: 'Roberto RH',
    text: 'Os cartões dos meus funcionários não chegaram e já faz duas semanas! Preciso de ajuda urgente.',
    waMessageId: 'm1', timestamp: Date.now(),
  })
  const botReply1 = sent.at(-1)?.text ?? '(sem resposta)'
  console.log(`${C.yellow}👤 Cliente:${C.reset} cartões não chegaram, urgente`)
  console.log(`${C.green}🤖 IA:${C.reset} ${botReply1}`)

  const [client] = await db.select().from(clients).where(eq(clients.phone, phone))
  const t1 = await latestTicket(client!.id)
  console.log(`${C.gray}   🎫 ticket: status=${t1?.status} prioridade=${t1?.priority} categoria=${t1?.category}${C.reset}`)
  console.log(`${C.gray}   (classify esperado: ${JSON.stringify(classify('cartões não chegaram urgente'))})${C.reset}`)

  const convId = t1!.conversationId!

  // ── 2) Sugestões da IA para o operador ────────────────────
  console.log(`\n${C.cyan}${C.bold}━━ 2) IA sugere respostas para o ATENDENTE ━━${C.reset}`)
  const sugg1 = await suggestReplies(convId, client!.id)
  sugg1.forEach((s, i) => console.log(`${C.green}   #${i + 1} [${s.tone}]${C.reset} ${s.text}`))

  // ── 3) Operador responde (open→pending) e resolve ─────────
  console.log(`\n${C.cyan}${C.bold}━━ 3) Operador responde e resolve ━━${C.reset}`)
  await sendOperatorReply(gateway, convId, 'Olá Roberto! Sou da Alelo. Já localizei o pedido e vou priorizar o reenvio dos cartões hoje. Te atualizo em até 24h.')
  let t1b = await latestTicket(client!.id)
  console.log(`${C.gray}   após resposta do operador → status=${t1b?.status} (esperado: pending)${C.reset}`)
  await transitionTicket(t1b!.id, 'resolved', { actor: 'operator:test', note: 'Reenvio agendado, cliente avisado.' })
  t1b = await latestTicket(client!.id)
  console.log(`${C.gray}   após resolver → status=${t1b?.status} resolvedAt=${t1b?.resolvedAt ? 'sim' : 'não'}${C.reset}`)

  // ── 4) Cliente volta → ticket REABRE com contexto ─────────
  console.log(`\n${C.cyan}${C.bold}━━ 4) Cliente volta dias depois → ticket REABRE ━━${C.reset}`)
  await inbound({
    from: `${phone}@s.whatsapp.net`, phone, pushName: 'Roberto RH',
    text: 'Oi, os cartões ainda não chegaram. Alguma novidade?',
    waMessageId: 'm2', timestamp: Date.now(),
  })
  const t1c = await latestTicket(client!.id)
  console.log(`${C.gray}   🔄 status=${t1c?.status} reopenCount=${t1c?.reopenCount} (esperado: open, 1)${C.reset}`)
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId))
  console.log(`${C.gray}   conversa status=${conv?.status} (esperado: waiting_human — bot fica em silêncio)${C.reset}`)

  // mensagens ligadas ao ticket (contexto preservado)
  const threadCount = (await db.select().from(messages).where(eq(messages.ticketId, t1c!.id))).length
  console.log(`${C.gray}   mensagens vinculadas ao ticket (contexto): ${threadCount}${C.reset}`)

  // ── 5) IA sugere de novo, agora com o contexto da reabertura ─
  console.log(`\n${C.cyan}${C.bold}━━ 5) IA sugere considerando a reabertura ━━${C.reset}`)
  const sugg2 = await suggestReplies(convId, client!.id)
  sugg2.forEach((s, i) => console.log(`${C.green}   #${i + 1} [${s.tone}]${C.reset} ${s.text}`))

  // ── 6) Transição inválida é rejeitada ─────────────────────
  console.log(`\n${C.cyan}${C.bold}━━ 6) Regra de transição (segurança) ━━${C.reset}`)
  console.log(`   open→closed permitido? ${canTransition('open', 'closed')}`)
  console.log(`   closed→pending permitido? ${canTransition('closed', 'pending')} (deve ser false)`)
  console.log(`   resolved→open (reabrir) permitido? ${canTransition('resolved', 'open')}`)

  // ── auditoria ─────────────────────────────────────────────
  const events = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, t1c!.id)).orderBy(ticketEvents.createdAt)
  console.log(`\n${C.cyan}${C.bold}━━ Auditoria do ticket ━━${C.reset}`)
  for (const e of events) {
    console.log(`${C.gray}   ${e.type}${e.fromStatus ? ` ${e.fromStatus}→${e.toStatus}` : ''} · ${e.actor}${e.note ? ` · ${e.note}` : ''}${C.reset}`)
  }

  // validação automática
  const ok =
    t1?.status === 'open' &&
    (t1?.priority === 'high' || t1?.priority === 'urgent') &&
    t1b !== undefined &&
    t1c?.status === 'open' &&
    (t1c?.reopenCount ?? 0) === 1 &&
    conv?.status === 'waiting_human' &&
    threadCount >= 2 &&
    sugg1.length > 0 &&
    sugg2.length > 0 &&
    canTransition('open', 'closed') &&
    !canTransition('closed', 'pending')
  console.log(`\n${ok ? C.green + '✓ PASS' : C.red + '✗ FALHOU'} — ciclo de vida + reabertura + sugestões${C.reset}`)

  // limpa
  await db.delete(clients).where(eq(clients.phone, phone))
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('ERRO:', e); process.exit(2) })
