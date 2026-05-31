import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { EvolutionGateway } from './whatsapp/evolution-gateway.js'
import { registerGateway } from './whatsapp/outbound.js'
import { applySavedProfile } from './domain/whatsapp-profile.js'
import { makeInboundHandler } from './domain/conversation-service.js'
import { flushOutbox, reconcileOldPending } from './domain/outbox.js'
import { buildServer } from './http/server.js'
import { startScheduler } from './jobs/scheduler.js'

async function main() {
  logger.info('Iniciando Alelo WhatsApp Platform…')

  // On boot, never resend old history: mark anything pending older than the
  // resend window as delivered (fixes the "enviou tudo de novo" on first run
  // after adding delivery tracking / after long downtime).
  await reconcileOldPending().catch((err) => logger.error({ err }, 'reconcileOldPending'))

  const gateway = new EvolutionGateway()
  registerGateway(gateway) // let AI tools / scheduler send messages + images
  gateway.onMessage(makeInboundHandler(gateway))
  // The instant WhatsApp reconnects, resend anything queued while offline so the
  // panel and WhatsApp stay in sync (user requirement).
  gateway.onReady(() => {
    flushOutbox(gateway).catch((err) => logger.error({ err }, 'flushOutbox onReady'))
  })

  // HTTP/WS server (operator UI + Evolution webhook receiver)
  const app = await buildServer(gateway)
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  logger.info(`API + WS ouvindo em http://localhost:${env.PORT}`)

  // Scheduler for renewals / NPS / follow-ups
  startScheduler(gateway)

  // Provision the Evolution instance + webhook and fetch QR for pairing
  await gateway.start()

  // Apply the saved/default WhatsApp profile (name/about/avatar) once connected.
  setTimeout(() => {
    applySavedProfile(gateway).catch((err) => logger.error({ err }, 'apply whatsapp profile'))
  }, 4000)

  const shutdown = async () => {
    logger.info('Encerrando…')
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  logger.error({ err }, 'Fatal na inicialização')
  process.exit(1)
})
