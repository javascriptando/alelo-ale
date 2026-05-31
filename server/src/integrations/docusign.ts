import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import docusign, { EnvelopesApi } from 'docusign-esign'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * DocuSign eSignature via JWT Grant (Service Integration) — lets the bot send
 * envelopes and create embedded signing URLs without the client logging in.
 *
 * One-time setup: grant consent by opening getConsentUrl() once in a browser
 * and approving. Token is then minted automatically per request (cached ~50min).
 */

const SCOPES = ['signature', 'impersonation']

export function isDocusignConfigured(): boolean {
  return Boolean(
    env.DOCUSIGN_INTEGRATION_KEY &&
      env.DOCUSIGN_USER_ID &&
      env.DOCUSIGN_ACCOUNT_ID &&
      safeReadKey(),
  )
}

function safeReadKey(): Buffer | null {
  try {
    const key = readFileSync(env.DOCUSIGN_PRIVATE_KEY_PATH)
    return key.length > 0 ? key : null
  } catch {
    return null
  }
}

function oauthHost(): string {
  return env.DOCUSIGN_OAUTH_BASE.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** URL the admin opens once to grant the integration consent. */
export function getConsentUrl(redirectUri: string): string {
  const scope = encodeURIComponent('signature impersonation')
  return `${env.DOCUSIGN_OAUTH_BASE}/oauth/auth?response_type=code&scope=${scope}&client_id=${env.DOCUSIGN_INTEGRATION_KEY}&redirect_uri=${encodeURIComponent(redirectUri)}`
}

let cached: { token: string; exp: number } | null = null

async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.token
  const key = safeReadKey()
  if (!key) throw new Error('DocuSign private key not found at ' + env.DOCUSIGN_PRIVATE_KEY_PATH)

  const client = new docusign.ApiClient()
  client.setOAuthBasePath(oauthHost())
  let res
  try {
    res = await client.requestJWTUserToken(
      env.DOCUSIGN_INTEGRATION_KEY,
      env.DOCUSIGN_USER_ID,
      SCOPES,
      key,
      3600,
    )
  } catch (err) {
    // Surface the real DocuSign OAuth error (e.g. consent_required) instead of a
    // generic "status code 400", so the caller knows to grant consent.
    const e = err as { response?: { body?: unknown; data?: unknown } }
    const body = e?.response?.body ?? e?.response?.data
    const errStr = typeof body === 'object' && body && 'error' in body ? (body as { error: string }).error : ''
    if (errStr === 'consent_required') {
      throw new Error('consent_required')
    }
    const detail = body ? JSON.stringify(body) : (err as Error).message
    throw new Error(`DocuSign JWT falhou: ${detail}`)
  }
  const token = res.body.access_token as string
  // Refresh a bit early.
  cached = { token, exp: Date.now() + 50 * 60 * 1000 }
  return token
}

function envelopesApi(token: string): EnvelopesApi {
  const client = new docusign.ApiClient()
  client.setBasePath(env.DOCUSIGN_BASE_PATH)
  client.addDefaultHeader('Authorization', `Bearer ${token}`)
  return new docusign.EnvelopesApi(client)
}

/** Inline the official Alelo SVG logo (from web/public) into the contract. */
function aleloLogoSvg(): string {
  for (const p of [
    resolve(process.cwd(), '../web/public/alelo-logo.svg'),
    resolve(process.cwd(), 'web/public/alelo-logo.svg'),
  ]) {
    try {
      const svg = readFileSync(p, 'utf8')
      if (svg.includes('<svg')) {
        // The source SVG carries width="2500" which renders huge in the PDF —
        // strip the fixed dims and pin a small width (viewBox keeps the ratio).
        return svg.replace(/\s(?:width|height)="[^"]*"/g, '').replace('<svg', '<svg width="84"')
      }
    } catch {
      /* try next path */
    }
  }
  return ''
}

function contractHtml(opts: {
  companyName: string
  signerName: string
  signerEmail: string
  cnpj: string
  monthlyTotal: string
  headcount: number
}): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#1b2b24;line-height:1.6;margin:0;background:#fff}
    .page{max-width:720px;margin:0 auto;padding:48px 56px}
    .header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #007858;padding-bottom:16px;margin-bottom:26px}
    .ttl{font-size:12px;color:#6b7c74;text-transform:uppercase;letter-spacing:.09em}
    .header h1{margin:2px 0 0;font-size:22px;color:#007858}
    h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#007858;margin:26px 0 8px;border-bottom:1px solid #e4ebe7;padding-bottom:4px}
    p{margin:8px 0}
    .grid{width:100%;border-collapse:collapse;margin-top:6px}
    .grid td{padding:8px 10px;border:1px solid #e4ebe7;font-size:14px;vertical-align:top}
    .grid td.k{background:#f3f8f5;color:#496157;width:38%;font-weight:600}
    .highlight{background:#eaf3ee;border:1px solid #cfe3d8;border-radius:10px;padding:16px 18px;margin:14px 0}
    .highlight .v{font-size:26px;font-weight:800;color:#007858}
    .terms{font-size:13px;color:#4a5a52}
    .sign{margin-top:44px;border-top:1px dashed #c3d3cb;padding-top:22px}
    .foot{margin-top:36px;font-size:11px;color:#8a988f;text-align:center;border-top:1px solid #eef2f0;padding-top:12px}
  </style></head><body>
    <div class="page">
      <div class="header">
        <div>${aleloLogoSvg()}</div>
        <div>
          <div class="ttl">Contrato de Adesão</div>
          <h1>Benefícios Alelo</h1>
        </div>
      </div>

      <p>Por meio deste instrumento particular, a empresa abaixo qualificada (<b>Contratante</b>)
      contrata da <b>Alelo</b> a prestação de serviços de gestão de benefícios aos seus colaboradores,
      nas condições a seguir.</p>

      <h2>Contratante</h2>
      <table class="grid">
        <tr><td class="k">Razão social</td><td>${opts.companyName}</td></tr>
        <tr><td class="k">CNPJ</td><td>${opts.cnpj || '—'}</td></tr>
        <tr><td class="k">Responsável</td><td>${opts.signerName}</td></tr>
        <tr><td class="k">E-mail</td><td>${opts.signerEmail}</td></tr>
      </table>

      <h2>Objeto e condições comerciais</h2>
      <table class="grid">
        <tr><td class="k">Colaboradores</td><td>${opts.headcount}</td></tr>
        <tr><td class="k">Benefício</td><td>Alelo — refeição, alimentação, mobilidade ou multibenefícios</td></tr>
      </table>
      <div class="highlight">
        <div class="terms">Valor mensal estimado</div>
        <div class="v">${opts.monthlyTotal}</div>
        <div class="terms">Inclui taxa de administração; plataforma de gestão isenta. O valor pode variar conforme a carga por colaborador definida.</div>
      </div>

      <h2>Vigência</h2>
      <p class="terms">Contrato por prazo indeterminado, com renovação automática mensal mediante pagamento,
      podendo ser cancelado por qualquer das partes com aviso prévio de 30 dias.</p>

      <h2>Validade jurídica</h2>
      <p class="terms">A assinatura eletrônica aposta neste documento possui plena validade jurídica,
      nos termos da MP 2.200-2/2001 (ICP-Brasil) e da Lei 14.063/2020.</p>

      <div class="sign">
        <p>E, por estarem assim justas e contratadas, as partes assinam eletronicamente:</p>
        <p><b>${opts.signerName}</b> — ${opts.companyName}</p>
        <p>/sig1/</p>
      </div>

      <div class="foot">Alelo · Documento gerado eletronicamente pela plataforma de atendimento.</div>
    </div>
  </body></html>`
}

export interface SignRequest {
  signerName: string
  signerEmail: string
  /** stable per-signer id for embedded signing (use the client id) */
  clientUserId: string
  companyName: string
  cnpj?: string
  monthlyTotal: string
  headcount: number
  /** where DocuSign redirects after signing in the embedded view */
  returnUrl: string
}

export interface SignResult {
  envelopeId: string
  signingUrl: string
}

export async function sendContractForSignature(req: SignRequest): Promise<SignResult> {
  const token = await getAccessToken()
  const api = envelopesApi(token)

  const doc = docusign.Document.constructFromObject({
    documentBase64: Buffer.from(
      contractHtml({
        companyName: req.companyName,
        signerName: req.signerName,
        signerEmail: req.signerEmail,
        cnpj: req.cnpj ?? '',
        monthlyTotal: req.monthlyTotal,
        headcount: req.headcount,
      }),
    ).toString('base64'),
    name: 'Contrato Alelo',
    fileExtension: 'html',
    documentId: '1',
  })

  const signHere = docusign.SignHere.constructFromObject({
    anchorString: '/sig1/',
    anchorUnits: 'pixels',
    anchorXOffset: '0',
    anchorYOffset: '-12',
  })

  const signer = docusign.Signer.constructFromObject({
    email: req.signerEmail,
    name: req.signerName,
    recipientId: '1',
    routingOrder: '1',
    clientUserId: req.clientUserId, // makes it an embedded recipient
    tabs: docusign.Tabs.constructFromObject({ signHereTabs: [signHere] }),
  })

  const envelopeDefinition = docusign.EnvelopeDefinition.constructFromObject({
    emailSubject: 'Assine seu contrato de benefícios Alelo',
    documents: [doc],
    recipients: docusign.Recipients.constructFromObject({ signers: [signer] }),
    status: 'sent',
  })

  const result = await api.createEnvelope(env.DOCUSIGN_ACCOUNT_ID, { envelopeDefinition })
  const envelopeId = result.envelopeId as string

  const viewRequest = docusign.RecipientViewRequest.constructFromObject({
    returnUrl: req.returnUrl,
    authenticationMethod: 'none',
    email: req.signerEmail,
    userName: req.signerName,
    clientUserId: req.clientUserId,
  })
  const view = await api.createRecipientView(env.DOCUSIGN_ACCOUNT_ID, envelopeId, {
    recipientViewRequest: viewRequest,
  })

  logger.info({ envelopeId }, 'DocuSign envelope criado')
  // Shorten the (very long) embedded signing URL so it's friendly on WhatsApp.
  return { envelopeId, signingUrl: await shortenUrl(view.url as string) }
}

/**
 * Shorten a long URL (e.g. the DocuSign signing link) via is.gd. Falls back to
 * the original URL on any failure — never blocks the flow.
 */
export async function shortenUrl(url: string): Promise<string> {
  try {
    const r = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`)
    if (r.ok) {
      const s = (await r.text()).trim()
      if (s.startsWith('http')) return s
    }
  } catch {
    /* keep original */
  }
  return url
}

/**
 * Current status of an envelope ("sent" | "delivered" | "completed" | ...).
 * Called directly over REST (avoids SDK typings) so a scheduler can detect a
 * signature without depending on the DocuSign Connect webhook.
 */
export async function getEnvelopeStatus(envelopeId: string): Promise<string> {
  const token = await getAccessToken()
  const base = env.DOCUSIGN_BASE_PATH.replace(/\/$/, '')
  const res = await fetch(
    `${base}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`DocuSign getEnvelope -> ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { status?: string }
  return String(body.status ?? '')
}
