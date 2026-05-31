import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(3333),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().optional().default(''),

  // ── WhatsApp via Evolution API ──────────────────────────
  EVOLUTION_API_URL: z.string().url().default('http://localhost:8080'),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().default('alelo'),
  // Public URL Evolution will POST inbound events to (this server + /webhook/whatsapp)
  EVOLUTION_WEBHOOK_URL: z.string().url().optional(),
  // Docker container names + Redis db index used to force-reset a zombie WhatsApp
  // session (logout/delete fail when Baileys is stuck in `state: open` zombie).
  EVOLUTION_CONTAINER: z.string().default('alelo-evolution'),
  EVOLUTION_DB_CONTAINER: z.string().default('alelo-db'),
  EVOLUTION_DB_NAME: z.string().default('evolution'),
  EVOLUTION_REDIS_CONTAINER: z.string().default('alelo-redis'),
  EVOLUTION_REDIS_DB: z.coerce.number().default(6),

  DOCUSIGN_BASE_PATH: z.string().default('https://demo.docusign.net/restapi'),
  DOCUSIGN_OAUTH_BASE: z.string().default('https://account-d.docusign.com'),
  DOCUSIGN_INTEGRATION_KEY: z.string().optional().default(''),
  DOCUSIGN_USER_ID: z.string().optional().default(''),
  DOCUSIGN_ACCOUNT_ID: z.string().optional().default(''),
  DOCUSIGN_PRIVATE_KEY_PATH: z.string().optional().default('./docusign_private.key'),
  DOCUSIGN_WEBHOOK_SECRET: z.string().optional().default(''),
  DOCUSIGN_SIGN_RETURN_URL: z.string().url().default('https://www.alelo.com.br'),

  // ── Asaas (PIX + cobranças) ───────────────────────────────
  ASAAS_API_KEY: z.string().optional().default(''),
  ASAAS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  ASAAS_WEBHOOK_TOKEN: z.string().optional().default(''),
  // DEV: when > 0, every PIX/subscription charge uses this fixed value (e.g. 1)
  // so you can actually pay during testing. Set to 0 in production.
  PIX_DEV_FIXED_VALUE: z.coerce.number().default(0),

  // Public base URL of THIS server, used to build the DocuSign consent redirect.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3333'),
})

export const env = schema.parse(process.env)
export type Env = typeof env
