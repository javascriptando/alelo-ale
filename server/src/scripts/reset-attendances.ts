/**
 * Zera TODOS os atendimentos para começar do zero, PRESERVANDO operadores e
 * suas sessões de login. Apaga clientes e tudo pendurado neles (conversas,
 * mensagens, tickets, eventos, cotações, contratos, cobranças, assinaturas,
 * beneficiários, NPS, notificações).
 *
 * Uso:  npx tsx src/scripts/reset-attendances.ts
 *
 * É destrutivo e irreversível — pensado para o ambiente de testes/dev.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { clients, operators } from '../db/schema.js'
import { logger } from '../config/logger.js'

async function reset() {
  // TRUNCATE ... CASCADE em `clients` derruba tudo que referencia clients via FK
  // (conversations, messages, tickets, ticket_events, quotes, contracts,
  // pix_charges, subscriptions, beneficiaries, nps_responses, notifications).
  // operators e sessions NÃO referenciam clients, então permanecem intactos.
  await db.execute(sql`TRUNCATE TABLE clients RESTART IDENTITY CASCADE`)

  // Contagem de sanidade pós-reset.
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(clients)
  const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(operators)

  logger.info({ clients: c?.n, operators: o?.n }, 'Reset concluído — atendimentos zerados, operadores preservados')
  console.log(`\n✅ Atendimentos zerados. clients=${c?.n ?? 0} | operadores preservados=${o?.n ?? 0}\n`)
  process.exit(0)
}

reset().catch((err) => {
  logger.error({ err }, 'Reset falhou')
  console.error('Reset falhou:', (err as Error).message)
  process.exit(1)
})
