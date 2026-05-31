/**
 * End-to-end HTTP test against the running server (port 3333):
 *  1. login as admin -> get session cookie
 *  2. POST a fake Evolution webhook (inbound WhatsApp message) -> triggers AI
 *  3. poll /api/conversations until it shows up
 *  4. fetch the thread and assert the bot replied
 *
 * NOTE: outbound sendText will fail (Evolution not paired) — that's expected and
 * the server logs it; the inbound->AI->persist path is what we validate here.
 */
const BASE = 'http://localhost:3333'
const PHONE = '5511988887777'

function cookieFrom(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? ''
  return sc.split(';')[0] ?? ''
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1) login
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@alelo.com', password: 'admin123' }),
  })
  console.log('login status:', login.status)
  if (!login.ok) throw new Error('login falhou: ' + (await login.text()))
  const cookie = cookieFrom(login)
  console.log('cookie obtido:', cookie ? 'sim' : 'NÃO')

  // 2) simulate Evolution inbound webhook (messages.upsert shape)
  const webhookPayload = {
    event: 'messages.upsert',
    instance: 'alelo',
    data: {
      key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: 'E2E_MSG_1' },
      pushName: 'Carlos RH E2E',
      message: { conversation: 'Olá, quero contratar vale alimentação para 120 funcionários' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  }
  const wh = await fetch(`${BASE}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookPayload),
  })
  console.log('webhook status:', wh.status)

  // 3) poll conversations (auth required)
  let convo: Record<string, unknown> | undefined
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    const res = await fetch(`${BASE}/api/conversations`, { headers: { cookie } })
    if (!res.ok) {
      console.log('  conversations status:', res.status)
      continue
    }
    const list = (await res.json()) as Record<string, unknown>[]
    convo = list.find((c) => String(c.phone) === PHONE)
    if (convo) break
    console.log(`  aguardando conversa aparecer... (${i + 1})`)
  }
  if (!convo) throw new Error('conversa não apareceu na API')
  console.log('\nconversa encontrada:', {
    empresa: convo.companyName,
    phone: convo.phone,
    status: convo.status,
  })

  // 4) fetch messages
  const msgsRes = await fetch(`${BASE}/api/conversations/${convo.id}/messages`, {
    headers: { cookie },
  })
  const msgs = (await msgsRes.json()) as { role: string; content: string; toolName: string | null }[]
  console.log('\n--- THREAD ---')
  for (const m of msgs) console.log(`[${m.role}${m.toolName ? '/' + m.toolName : ''}] ${m.content.slice(0, 120)}`)

  const botReplied = msgs.some((m) => m.role === 'bot')
  const usedQuote = msgs.some((m) => (m.toolName ?? '').includes('calcular_cotacao'))

  // 5) stats sanity
  const stats = await (await fetch(`${BASE}/api/stats`, { headers: { cookie } })).json()
  console.log('\nstats:', stats)

  const ok = botReplied && usedQuote
  console.log('\nRESULTADO E2E:', ok ? 'PASS ✔ (inbound→IA→cotação→persistido→API)' : 'FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO E2E:', err)
  process.exit(2)
})
