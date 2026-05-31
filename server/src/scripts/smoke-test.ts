/**
 * End-to-end smoke test harness.
 *
 * Drives the REAL conversation pipeline (agent + tools + domain services) through
 * a FAKE WhatsApp gateway that captures outbound messages instead of sending
 * them, so we can validate "are we ready for many case types" without spamming
 * anyone. Also exercises the deterministic building blocks we recently changed
 * (full-value PIX, ticket hash, message segmentation, beneficiary CRUD).
 *
 * Run:  npx tsx src/scripts/smoke-test.ts
 * It does NOT reset the DB — run the reset separately when you're done.
 */
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  clients,
  conversations,
  messages,
  quotes,
  beneficiaries,
  pixCharges,
  tickets,
  npsResponses,
} from '../db/schema.js'
import { makeInboundHandler } from '../domain/conversation-service.js'
import type { InboundMessage, WhatsAppGateway } from '../whatsapp/gateway.js'
import { createAndSendPix, reconcileClientCharges } from '../domain/payment-service.js'
import { splitForDelivery } from '../integrations/elevenlabs.js'
import { isAsaasConfigured } from '../integrations/asaas.js'

// ── Fake gateway: record everything, send nothing ──────────────────────────
interface Sent {
  type: 'text' | 'media' | 'audio'
  phone: string
  content: string
}
class FakeGateway implements WhatsAppGateway {
  sent: Sent[] = []
  async start(): Promise<void> {}
  async sendText(phone: string, text: string): Promise<void> {
    // Mirror the real gateway: split into audio/text segments so we can assert
    // the right channel is used per segment, but never hit ElevenLabs/Evolution.
    for (const seg of splitForDelivery(text)) {
      this.sent.push({ type: seg.kind === 'audio' ? 'audio' : 'text', phone, content: seg.content })
    }
  }
  async sendImage(phone: string, _base64: string, caption?: string): Promise<void> {
    this.sent.push({ type: 'media', phone, content: caption ?? '' })
  }
  onMessage(): void {}
  isReady(): boolean {
    return true
  }
}

// Replicates web/components/ui.tsx ticketRef — kept in sync by hand.
const ticketRef = (id: string) => '#' + id.replace(/-/g, '').slice(0, 8).toUpperCase()

// ── Tiny assertion framework ───────────────────────────────────────────────
interface Result {
  name: string
  ok: boolean
  detail: string
}
const results: Result[] = []
function check(name: string, cond: boolean, detail = '') {
  results.push({ name, ok: cond, detail })
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`)
}
async function safe(name: string, fn: () => Promise<void>) {
  try {
    await fn()
  } catch (err) {
    check(name, false, `threw: ${(err as Error).message}`)
  }
}

// Unique per RUN so re-runs never collide with prior clients or get deduped by
// the inbound waMessageId guard (which is correct production behavior).
const RUN = Date.now().toString().slice(-7)
let phoneSeq = 0
const nextPhone = () => `5511${RUN}${(phoneSeq++).toString().padStart(2, '0')}`

async function clientByPhone(phone: string) {
  const [c] = await db.select().from(clients).where(eq(clients.phone, phone))
  return c
}

// ── PART 1: deterministic building blocks ──────────────────────────────────
function testSegmentation() {
  const sample = [
    'Segue sua cotação:',
    'Total mensal: R$ 1.500,00',
    'Taxa de adesão: R$ 0,00',
    'Quer seguir para a assinatura do contrato?',
  ].join('\n')
  const segs = splitForDelivery(sample)
  const kinds = segs.map((s) => `${s.kind}:${s.content.slice(0, 30).replace(/\n/g, ' ')}`).join(' | ')
  console.log(`        ↳ ${kinds}`)
  const dataAsText = segs
    .filter((s) => /R\$|Total|Taxa/.test(s.content))
    .every((s) => s.kind === 'text')
  const questionAsAudio = segs.some((s) => /assinatura do contrato/.test(s.content) && s.kind === 'audio')
  check('segmentação: valores/cotação como TEXTO', dataAsText)
  check('segmentação: frase conversacional como ÁUDIO', questionAsAudio)

  const linkSegs = splitForDelivery('Assine aqui: https://demo.docusign.net/Signing/abc?slt=xyz')
  check('segmentação: link nunca vira áudio', linkSegs.every((s) => (/https?:\/\//.test(s.content) ? s.kind === 'text' : true)))
  const pixSegs = splitForDelivery('00020126580014br.gov.bcb.pix0136abc...5204000053039865802BR6304ABCD')
  check('segmentação: código PIX nunca vira áudio', pixSegs.every((s) => s.kind === 'text'))
}

function testTicketRef() {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const ref = ticketRef(id)
  check('ticket hash: formato #8HEX', /^#[0-9A-F]{8}$/.test(ref), ref)
  check('ticket hash: determinístico', ticketRef(id) === ref)
  check('ticket hash: ids diferentes → refs diferentes', ticketRef('aaaaaaaa-0000-0000-0000-000000000000') !== ref)
}

// ── PART 2: full-value PIX (charges R$5 in dev, must DISPLAY/STORE real value) ─
async function testFullValuePix() {
  if (!isAsaasConfigured()) {
    check('PIX valor cheio', false, 'Asaas não configurado — pulei')
    return
  }
  const phone = nextPhone()
  // Real flow always has a CNPJ by the PIX stage (collected at contract step).
  const [c] = await db
    .insert(clients)
    .values({
      companyName: 'Teste Valor Cheio LTDA',
      phone,
      contactName: 'Fulano',
      cnpj: '11444777000161',
      email: 'fulano@teste.com.br',
      stage: 'quote',
    })
    .returning()
  if (!c) {
    check('PIX: cliente seed', false, 'falha ao criar cliente')
    return
  }
  const REAL = 1500
  const res = await createAndSendPix(c.id, { value: REAL, description: 'Teste valor cheio' })
  check('PIX: cobrança criada', res.ok, res.message)
  const [charge] = await db.select().from(pixCharges).where(eq(pixCharges.clientId, c.id))
  if (charge) {
    check('PIX: value cobrado = R$5 (dev)', Number(charge.value) === 5, `value=${charge.value}`)
    check('PIX: fullValue = valor real (1500)', Number(charge.fullValue) === REAL, `fullValue=${charge.fullValue}`)
  } else {
    check('PIX: charge persistida', false, 'nenhuma charge encontrada')
  }

  // Edge case the harness discovered: PIX requested with NO CNPJ must fail with
  // a clear, actionable message (not a generic API error).
  const phone2 = nextPhone()
  const [c2] = await db
    .insert(clients)
    .values({ companyName: 'Sem CNPJ LTDA', phone: phone2, stage: 'quote' })
    .returning()
  if (c2) {
    const r2 = await createAndSendPix(c2.id, { value: 1000 })
    check('PIX: sem CNPJ → mensagem clara pedindo CNPJ', !r2.ok && /CNPJ/i.test(r2.message), r2.message)
  }
}

// ── PART 3: beneficiary CRUD (direct, no external) ─────────────────────────
async function testBeneficiaryCrud() {
  const phone = nextPhone()
  const [c] = await db.insert(clients).values({ companyName: 'Teste Assoc LTDA', phone, stage: 'active' }).returning()
  if (!c) {
    check('associado: cliente seed', false)
    return
  }
  const [b] = await db
    .insert(beneficiaries)
    .values({ clientId: c.id, name: 'João Silva', cpf: '11122233344', benefitType: 'refeicao' })
    .returning()
  check('associado: criado', !!b?.id)
  if (!b) return
  await db.update(beneficiaries).set({ name: 'João Souza' }).where(eq(beneficiaries.id, b.id))
  const [edited] = await db.select().from(beneficiaries).where(eq(beneficiaries.id, b.id))
  check('associado: editado', edited?.name === 'João Souza', edited?.name)
  await db.delete(beneficiaries).where(eq(beneficiaries.id, b.id))
  const [gone] = await db.select().from(beneficiaries).where(eq(beneficiaries.id, b.id))
  check('associado: excluído', !gone)
}

// ── PART 4: reconciliation safety on empty client ──────────────────────────
async function testReconcileSafety() {
  const phone = nextPhone()
  const [c] = await db.insert(clients).values({ companyName: 'Teste Recon', phone, stage: 'lead' }).returning()
  if (!c) {
    check('reconciliação: cliente seed', false)
    return
  }
  await reconcileClientCharges(c.id) // must not throw even with zero charges
  check('reconciliação: cliente sem cobranças não quebra', true)
}

// ── PART 5: multi-turn conversations via the REAL agent ─────────────────────
function inbound(phone: string, text: string, n = 1): InboundMessage {
  return {
    from: `${phone}@s.whatsapp.net`,
    phone,
    text,
    waMessageId: `smoke-${phone}-${n}`,
    pushName: 'Cliente Teste',
    timestamp: 1_700_000_000 + Number(phone.slice(-6)),
  }
}

/**
 * A multi-turn session against ONE client/phone. Feeds each client turn into the
 * real handler and captures the bot's segments per turn, so we can drive a
 * conversation all the way to the end and read it like a transcript.
 */
class Session {
  readonly phone = nextPhone()
  private seq = 0
  constructor(
    private handle: (m: InboundMessage) => Promise<void> | void,
    private gw: FakeGateway,
  ) {}

  /** Send one client message; returns the bot segments produced by this turn. */
  async say(text: string): Promise<Sent[]> {
    const before = this.gw.sent.length
    this.seq += 1
    console.log(`   👤 ${text}`)
    await this.handle(inbound(this.phone, text, this.seq))
    const out = this.gw.sent.slice(before).filter((s) => s.phone === this.phone)
    for (const s of out) {
      const tag = s.type === 'audio' ? '🔊' : s.type === 'media' ? '🖼️ ' : '💬'
      console.log(`   🤖 ${tag} ${s.content.slice(0, 100).replace(/\n/g, ' ')}`)
    }
    if (!out.length) console.log('   🤖 (sem resposta)')
    return out
  }

  /** All bot text/audio so far, concatenated — handy for content assertions. */
  said(): string {
    return this.gw.sent.filter((s) => s.phone === this.phone).map((s) => s.content).join('\n')
  }

  async client() {
    return clientByPhone(this.phone)
  }
  async activeTicket() {
    const c = await this.client()
    if (!c) return undefined
    const [t] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.clientId, c.id))
      .orderBy(desc(tickets.createdAt))
      .limit(1)
    return t
  }
}

/**
 * The headline test the operator asked for: a REAL back-and-forth that runs all
 * the way to the NPS and the captured score — not just one message. Uses a
 * support-style flow (no DocuSign/Asaas externals) so it's deterministic, but it
 * exercises the FULL lifecycle of an attendance: abertura → resolução →
 * encerramento → NPS enviado → nota respondida → agradecimento → ticket resolved.
 */
async function testFullConversationToNps(handle: (m: InboundMessage) => Promise<void> | void, gw: FakeGateway) {
  console.log('\n   ━━ Conversa completa até o NPS ━━')
  const s = new Session(handle, gw)

  check('full-NPS: respondeu à saudação', (await s.say('Oi! Tudo bem? Tenho uma dúvida sobre o vale refeição.')).length > 0)
  check('full-NPS: respondeu à dúvida', (await s.say('Como funciona a recarga mensal do benefício?')).length > 0)
  await s.say('Entendi, perfeito. Era só isso mesmo, muito obrigado!')
  check('full-NPS: continua respondendo no encerramento', (await s.say('Não, obrigado. Pode encerrar o atendimento.')).length > 0)

  // The agent may need an explicit nudge to fire the survey; allow a couple.
  const npsPending = async () => {
    const c = await s.client()
    if (!c) return undefined
    const [n] = await db
      .select()
      .from(npsResponses)
      .where(eq(npsResponses.clientId, c.id))
      .orderBy(desc(npsResponses.sentAt))
      .limit(1)
    return n
  }
  let nps = await npsPending()
  for (let i = 0; i < 2 && (!nps || nps.sentAt == null); i++) {
    await s.say('Pode mandar a pesquisa de satisfação, sem problema.')
    nps = await npsPending()
  }
  check('full-NPS: pesquisa NPS enviada (pending)', !!nps && nps.sentAt != null && nps.score == null)

  if (nps) {
    const before = gw.sent.length
    await s.say('Nota 10! Atendimento excelente.')
    const out = gw.sent.slice(before)
    const [after] = await db.select().from(npsResponses).where(eq(npsResponses.id, nps.id))
    check('full-NPS: nota capturada (10)', after?.score === 10, `score=${after?.score}`)
    check('full-NPS: agradecimento enviado após a nota', out.length > 0)

    const npsTicketId = after?.ticketId ?? nps.ticketId
    const [npsTicket] = npsTicketId ? await db.select().from(tickets).where(eq(tickets.id, npsTicketId)) : []
    check('full-NPS: ticket do NPS resolvido', npsTicket?.status === 'resolved', `status=${npsTicket?.status}`)

    // The old bug: history stopped at the NPS question. Now both the score reply
    // and the thank-you must be persisted.
    const c2 = await s.client()
    const [convoRow] = c2 ? await db.select().from(conversations).where(eq(conversations.clientId, c2.id)) : []
    const last = convoRow
      ? await db.select().from(messages).where(eq(messages.conversationId, convoRow.id)).orderBy(desc(messages.createdAt)).limit(3)
      : []
    const hasBotThanks = last.some((m) => m.role === 'bot')
    const hasClientScore = last.some((m) => m.role === 'client' && /10/.test(m.content))
    check('full-NPS: histórico tem a nota do cliente E o agradecimento', hasBotThanks && hasClientScore)
  }
}

/**
 * Triage bug the operator reported: on a complaint the Alê must NOT escalate
 * blindly — it asks questions first, THEN escalates with a real summary. Also
 * verifies it does NOT re-ask data we already have (the company name we seeded).
 */
async function testTriageBeforeEscalation(handle: (m: InboundMessage) => Promise<void> | void, gw: FakeGateway) {
  console.log('\n   ━━ Triagem antes de escalar (reclamação) ━━')
  const s = new Session(handle, gw)
  // Seed a KNOWN client so we can assert the bot doesn't re-ask the company name.
  await db
    .insert(clients)
    .values({
      companyName: 'Padaria Pão Quente LTDA',
      phone: s.phone,
      cnpj: '11444777000161',
      contactName: 'Maria',
      stage: 'active',
    })
    .onConflictDoNothing()

  await s.say('Isso é um absurdo! O cartão dos meus funcionários não está funcionando e quero cancelar tudo agora!')
  const t1 = await s.activeTicket()
  check('triagem: NÃO escalou na 1ª mensagem (segue com a Alê)', t1?.handlingMode === 'ai', `handlingMode=${t1?.handlingMode}`)

  await s.say('Começou ontem, em todas as maquininhas. Já tentei em duas lojas e não passou de jeito nenhum.')
  await s.say('Preciso muito de ajuda com isso, está travando o benefício de todo mundo.')

  const t2 = await s.activeTicket()
  const escalated = t2?.handlingMode === 'queue' || t2?.handlingMode === 'human'
  check('triagem: escalou DEPOIS da triagem', escalated, `handlingMode=${t2?.handlingMode}`)
  check('triagem: escalou com summary (atendente começa informado)', !!t2?.summary && t2.summary.length >= 25, t2?.summary?.slice(0, 80) ?? '(vazio)')
  // We already had the company name on file → the bot must not have asked for it.
  check('triagem: NÃO pediu dado que já temos (nome da empresa)', !/(qual|informe).{0,30}(nome|raz[aã]o social).{0,30}empresa/i.test(s.said()))
}

/** Insistence escape hatch: client demands a human and refuses triage → escalate. */
async function testInsistenceEscalation(handle: (m: InboundMessage) => Promise<void> | void, gw: FakeGateway) {
  console.log('\n   ━━ Cliente insiste em humano ━━')
  const s = new Session(handle, gw)
  await s.say('Quero falar com um atendente humano.')
  await s.say('Não quero responder nada, só me transfere para uma pessoa AGORA.')
  await s.say('Humano. Agora. Por favor.')
  const t = await s.activeTicket()
  const escalated = t?.handlingMode === 'queue' || t?.handlingMode === 'human'
  check('insistência: acabou escalando para humano', escalated, `handlingMode=${t?.handlingMode}`)
}

async function testCotacaoCreatesQuote(handle: (m: InboundMessage) => Promise<void> | void) {
  // Multi-turn: the agent (correctly) confirms details before quoting, so we
  // simulate a short back-and-forth until the cotação is actually generated.
  const phone = nextPhone()
  const turns = [
    'Quero uma cotação de vale refeição para 30 colaboradores, valor de R$ 30 por dia.',
    'Isso mesmo: 30 colaboradores, R$ 30 por dia útil. Pode gerar a cotação.',
    'Sim, confirmo. Pode calcular o valor total mensal por favor.',
  ]
  let made = 0
  for (let i = 0; i < turns.length; i++) {
    await handle(inbound(phone, turns[i]!, i + 1))
    const client = await clientByPhone(phone)
    if (client) {
      const qs = await db.select().from(quotes).where(eq(quotes.clientId, client.id))
      made = qs.length
      if (made > 0) break
    }
  }
  check('intent cotação: gerou cotação após confirmação', made > 0, `${made} cotação(ões)`)
}

async function main() {
  console.log('\n========== SMOKE TEST ALELO ==========\n')
  const gw = new FakeGateway()
  const handle = makeInboundHandler(gw)

  console.log('── Parte 1: blocos determinísticos ──')
  testSegmentation()
  testTicketRef()

  console.log('\n── Parte 2: PIX valor cheio (cobra R$5, mostra real) ──')
  await safe('pix-valor-cheio', testFullValuePix)

  console.log('\n── Parte 3: CRUD de associados ──')
  await safe('assoc-crud', testBeneficiaryCrud)

  console.log('\n── Parte 4: reconciliação segura ──')
  await safe('reconcile', testReconcileSafety)

  console.log('\n── Parte 5: cotação multi-turno (agente real) ──')
  await safe('cotacao-quote', () => testCotacaoCreatesQuote(handle))

  console.log('\n── Parte 6: conversa COMPLETA até o NPS ──')
  await safe('full-conversa-nps', () => testFullConversationToNps(handle, gw))

  console.log('\n── Parte 7: triagem antes de escalar ──')
  await safe('triagem-escalacao', () => testTriageBeforeEscalation(handle, gw))
  await safe('insistencia-escalacao', () => testInsistenceEscalation(handle, gw))

  const pass = results.filter((r) => r.ok).length
  const fail = results.length - pass
  console.log('\n========== RESUMO ==========')
  console.log(`Total: ${results.length}  |  PASS: ${pass}  |  FAIL: ${fail}`)
  if (fail > 0) {
    console.log('\nFalhas:')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  x ${r.name} -- ${r.detail}`))
  }
  console.log('\n(DB NAO foi resetado. Rode o reset separadamente.)\n')
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('HARNESS CRASH:', err)
  process.exit(2)
})
