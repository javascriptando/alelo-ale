import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import qrcode from 'qrcode'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { jidToPhone, type InboundHandler, type WhatsAppGateway } from './gateway.js'
import { toWhatsApp } from './format.js'
import { transcribeAudio } from '../ai/openai.js'
import { isElevenLabsConfigured, isSpeakable, textToSpeechBase64 } from '../integrations/elevenlabs.js'

const execFileAsync = promisify(execFile)

/**
 * WhatsApp gateway backed by Evolution API (https://github.com/EvolutionAPI/evolution-api).
 *
 * Evolution runs as a separate service (Docker). This gateway:
 *  - ensures the instance exists and points its webhook back at this server,
 *  - sends outbound text via REST,
 *  - receives inbound messages through `handleWebhook` (called by the HTTP route),
 *  - tracks connection state and exposes the QR code for first-time pairing.
 */
const EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']

export class EvolutionGateway implements WhatsAppGateway {
  private handlers: InboundHandler[] = []
  private ready = false
  private lastQrBase64: string | null = null
  /** Last time we asked Evolution to (re)connect — throttle to avoid resetting
      an in-progress pairing handshake when the UI polls status frequently. */
  private lastConnectAt = 0
  private static CONNECT_THROTTLE_MS = 20_000
  /** Callbacks fired when the connection transitions to OPEN (e.g. flush outbox). */
  private readyListeners: (() => void)[] = []

  /** Register a callback to run whenever the WhatsApp connection becomes ready. */
  onReady(cb: () => void): void {
    this.readyListeners.push(cb)
  }

  /** Flip ready state; on a false→true transition, notify listeners once. */
  private setReady(next: boolean): void {
    const was = this.ready
    this.ready = next
    if (next && !was) {
      if (next) this.lastQrBase64 = null
      for (const cb of this.readyListeners) {
        try {
          cb()
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'onReady listener falhou')
        }
      }
    }
  }

  onMessage(handler: InboundHandler): void {
    this.handlers.push(handler)
  }

  isReady(): boolean {
    return this.ready
  }

  /** Base64 PNG data URL of the current pairing QR, if waiting to connect. */
  getQr(): string | null {
    return this.lastQrBase64
  }

  private url(path: string): string {
    return `${env.EVOLUTION_API_URL.replace(/\/$/, '')}${path}`
  }

  private async call(path: string, init?: RequestInit) {
    const res = await fetch(this.url(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: env.EVOLUTION_API_KEY,
        ...(init?.headers ?? {}),
      },
    })
    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) {
      throw new Error(`Evolution ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
    }
    return body as Record<string, unknown>
  }

  async start(): Promise<void> {
    const instance = env.EVOLUTION_INSTANCE
    const webhookUrl = env.EVOLUTION_WEBHOOK_URL

    // 0) If the instance is ALREADY connected (e.g. backend restarted while the
    // WhatsApp session is live), DO NOT re-provision. Re-running create/settings/
    // connect against a live socket makes WhatsApp "replace" it in a loop
    // (conflict: replaced). Just re-assert the webhook (safe) and adopt the
    // existing connection.
    let currentState: string | null = null
    try {
      const st = await this.call(`/instance/connectionState/${instance}`)
      currentState = ((st.instance as Record<string, unknown>)?.state ?? st.state) as string
    } catch {
      /* instance probably doesn't exist yet */
    }
    if (currentState === 'open') {
      this.setReady(true)
      if (webhookUrl) await this.assertWebhook(instance, webhookUrl)
      logger.info('Evolution: já conectado — adotando sessão existente (sem re-provisionar)')
      return
    }

    // 1) Ensure the instance exists (idempotent: ignore "already exists").
    try {
      await this.call('/instance/create', {
        method: 'POST',
        body: JSON.stringify({
          instanceName: instance,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          ...(webhookUrl
            ? { webhook: { url: webhookUrl, byEvents: false, events: EVENTS } }
            : {}),
        }),
      })
      logger.info({ instance }, 'Evolution: instância criada')
    } catch (err) {
      logger.info({ err: (err as Error).message }, 'Evolution: instância provavelmente já existe (ok)')
    }

    // 1b) Harden the instance so the session stays alive: alwaysOnline keeps the
    // socket warm (fewer drops), and we don't sync full history (faster, lighter).
    try {
      await this.call(`/settings/set/${instance}`, {
        method: 'POST',
        body: JSON.stringify({
          rejectCall: false,
          groupsIgnore: true,
          alwaysOnline: true,
          readMessages: false,
          readStatus: false,
          syncFullHistory: false,
        }),
      })
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Evolution: falha ao aplicar settings (ok)')
    }

    // 2) (Re)assert the webhook so inbound events reach us.
    if (webhookUrl) await this.assertWebhook(instance, webhookUrl)

    // 3) Check connection / fetch QR for pairing.
    await this.refreshConnection()
  }

  /** Idempotently point the instance webhook back at this server. */
  private async assertWebhook(instance: string, webhookUrl: string): Promise<void> {
    try {
      await this.call(`/webhook/set/${instance}`, {
        method: 'POST',
        body: JSON.stringify({
          webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: true, events: EVENTS },
        }),
      })
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Evolution: falha ao setar webhook')
    }
  }

  /**
   * Read the live connection state (cheap, safe to call often — used by the UI
   * status poll). Updates `ready` and clears the QR once connected. Does NOT
   * trigger a connect, so frequent polling never disturbs pairing.
   * Returns the raw state string ('open' | 'connecting' | 'close' | ...).
   */
  async refreshConnection(): Promise<string | null> {
    const instance = env.EVOLUTION_INSTANCE
    try {
      const state = await this.call(`/instance/connectionState/${instance}`)
      const s = ((state.instance as Record<string, unknown>)?.state ?? state.state) as string
      this.setReady(s === 'open') // fires onReady (flush outbox) on false→true
      // Only (re)fetch a QR when the socket is fully CLOSED — never while it is
      // 'connecting' (a scan handshake in progress): calling /instance/connect
      // mid-handshake resets it and the phone "keeps dropping".
      if (s === 'close') await this.ensureQr()
      return s
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Evolution: não foi possível obter estado')
      return null
    }
  }

  /** Ask Evolution for a pairing QR, throttled so we never spam /connect. */
  private async ensureQr(): Promise<void> {
    const now = Date.now()
    if (now - this.lastConnectAt < EvolutionGateway.CONNECT_THROTTLE_MS) return
    this.lastConnectAt = now
    try {
      const conn = await this.call(`/instance/connect/${env.EVOLUTION_INSTANCE}`)
      await this.storeQrFromConnect(conn)
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Evolution: falha ao obter QR')
    }
  }

  /**
   * Explicit pairing intent (QR page / admin "reconectar"): refresh state and,
   * if not connected, force-fetch a QR bypassing the throttle. Safe because it's
   * only triggered by a human action, not by background polling.
   */
  async forceQr(): Promise<void> {
    const s = await this.refreshConnection()
    if (this.ready) return
    if (s !== 'connecting') {
      this.lastConnectAt = 0 // bypass throttle for an explicit request
      await this.ensureQr()
    }
  }

  /** Restart the instance connection to recover a dead/zombie session. */
  async reconnect(): Promise<void> {
    const instance = env.EVOLUTION_INSTANCE
    try {
      await this.call(`/instance/restart/${instance}`, { method: 'POST' })
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Evolution: restart falhou')
    }
    // Give it a moment to come back, then re-check state / fetch a fresh QR.
    await new Promise((r) => setTimeout(r, 1500))
    await this.refreshConnection()
  }

  /** Resolve the Evolution Instance UUID (needed to target Session/Redis rows). */
  private async instanceId(): Promise<string | null> {
    try {
      const list = (await this.call('/instance/fetchInstances')) as unknown
      const arr = Array.isArray(list) ? list : []
      const found = arr.find(
        (i) => (i as Record<string, unknown>)?.name === env.EVOLUTION_INSTANCE,
      ) as Record<string, unknown> | undefined
      return (found?.id as string) ?? null
    } catch {
      return null
    }
  }

  /**
   * Fully disconnect the current number and generate a fresh pairing QR.
   *
   * Evolution/Baileys can get stuck in a "zombie" state: the instance reports
   * `state: open` while the socket is actually dead (endless
   * `fetchPrivacySettings`/"Connection Closed" loop) — messages stop flowing in
   * BOTH directions and the REST `logout`/`delete` endpoints fail (500/400).
   * The only reliable reset is at the source, which is what this does:
   *   1) best-effort API logout (clean path when the socket is healthy),
   *   2) wipe the stored Baileys credentials — Postgres `Session` row +
   *      the `evolution:instance:<id>` key in Redis,
   *   3) mark the Instance `close`,
   *   4) restart the Evolution container so it reloads with no creds,
   *   5) pull a brand-new QR for pairing.
   * Verified against Evolution 2.3.7 (Postgres + Redis cache).
   */
  async disconnect(): Promise<void> {
    const instance = env.EVOLUTION_INSTANCE
    const id = await this.instanceId()

    // 1) Clean path first — succeeds only if the socket isn't a zombie.
    try {
      await this.call(`/instance/logout/${instance}`, { method: 'DELETE' })
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Evolution: logout (best-effort) falhou; forçando reset')
    }

    this.ready = false
    this.lastQrBase64 = null

    if (id) {
      // 2) Wipe credentials at the source: Postgres Session + Redis cache key.
      const sql =
        `DELETE FROM "Session" WHERE "sessionId"='${id}';` +
        ` UPDATE "Instance" SET "connectionStatus"='close' WHERE id='${id}';`
      try {
        await execFileAsync('docker', [
          'exec', env.EVOLUTION_DB_CONTAINER,
          'psql', '-U', 'postgres', '-d', env.EVOLUTION_DB_NAME, '-c', sql,
        ])
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Evolution: falha ao limpar Session no Postgres')
      }
      try {
        await execFileAsync('docker', [
          'exec', env.EVOLUTION_REDIS_CONTAINER,
          'redis-cli', '-n', String(env.EVOLUTION_REDIS_DB), 'DEL', `evolution:instance:${id}`,
        ])
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Evolution: falha ao limpar cache Redis')
      }
      logger.info({ id }, 'Evolution: credenciais apagadas (Postgres + Redis)')
    } else {
      logger.warn('Evolution: instanceId não encontrado; reset por banco pulado')
    }

    // 4) Restart the container so Baileys reloads without the old session.
    try {
      await execFileAsync('docker', ['restart', env.EVOLUTION_CONTAINER])
      logger.info('Evolution: container reiniciado')
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Evolution: falha ao reiniciar container')
    }

    // 5) Wait for Evolution's HTTP to come back, then fetch a fresh QR.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      try {
        await this.call('/')
        break
      } catch {
        /* still booting */
      }
    }
    await this.refreshConnection()
  }

  /**
   * Evolution v2 /instance/connect returns either { base64 } (a PNG) or
   * { code, pairingCode } where `code` is the raw QR string — in that case we
   * render the PNG ourselves so the UI/route always has an image.
   */
  private async storeQrFromConnect(conn: Record<string, unknown>): Promise<void> {
    const base64 = conn.base64 as string | undefined
    const code = conn.code as string | undefined
    if (base64) {
      this.lastQrBase64 = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
    } else if (code) {
      this.lastQrBase64 = await qrcode.toDataURL(code)
    }
    if (this.lastQrBase64) {
      logger.info('Evolution: QR disponível em GET /whatsapp/qr (abra no navegador para parear)')
    }
  }

  async sendText(phone: string, text: string): Promise<void> {
    const number = phone.replace(/\D/g, '')
    // Voice-first: speak natural-language replies (codes/links stay as text).
    if (isElevenLabsConfigured() && isSpeakable(text)) {
      const audio = await textToSpeechBase64(text).catch(() => null)
      if (audio) {
        await this.sendAudioNote(number, audio)
        return
      }
      // TTS failed → fall through to text so the message is never lost.
    }
    const body = toWhatsApp(text)
    // Human touch: show "typing…" for a short, length-proportional time before
    // the message lands, so the bot doesn't feel instant/robotic.
    await this.showTyping(number, body)
    // Single chokepoint: convert markdown → WhatsApp formatting for all outbound.
    await this.call(`/message/sendText/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ number, text: body }),
    })
  }

  /** Send a base64 MP3 as a WhatsApp voice note (Evolution transcodes to opus). */
  private async sendAudioNote(number: string, base64Mp3: string): Promise<void> {
    // Show "recording audio…" briefly for realism, then send.
    try {
      await this.call(`/chat/sendPresence/${env.EVOLUTION_INSTANCE}`, {
        method: 'POST',
        body: JSON.stringify({ number, presence: 'recording', delay: 1500 }),
      })
      await new Promise((r) => setTimeout(r, 1200))
    } catch {
      /* presence is cosmetic */
    }
    await this.call(`/message/sendWhatsAppAudio/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ number, audio: base64Mp3, encoding: true }),
    })
  }

  /**
   * Briefly broadcast the "composing" (digitando…) presence before sending, for
   * a duration that scales with the message length (clamped 0.8s–4s). The
   * Evolution `delay` keeps the presence alive server-side; we also wait the
   * same time locally so the message actually lands after the typing shows.
   * Best effort: any failure is swallowed so it never blocks the actual send.
   */
  private async showTyping(number: string, text: string): Promise<void> {
    // ~60ms/char, min 800ms, max 4s — feels like a person typing a reply.
    const ms = Math.min(4000, Math.max(800, text.length * 60))
    try {
      await this.call(`/chat/sendPresence/${env.EVOLUTION_INSTANCE}`, {
        method: 'POST',
        body: JSON.stringify({ number, presence: 'composing', delay: ms }),
      })
    } catch {
      /* presence is cosmetic — never block the send */
    }
    await new Promise((r) => setTimeout(r, ms))
  }

  /** Send an image via Evolution's media endpoint (base64, no data: prefix). */
  async sendImage(phone: string, base64: string, caption?: string): Promise<void> {
    const number = phone.replace(/\D/g, '')
    // Short "typing…" before media too, so the QR/image feels hand-sent.
    await this.showTyping(number, caption ?? '')
    const media = base64.replace(/^data:image\/\w+;base64,/, '')
    await this.call(`/message/sendMedia/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({
        number,
        mediatype: 'image',
        media,
        fileName: 'pix.png',
        caption: caption ? toWhatsApp(caption) : undefined,
      }),
    })
  }

  /** Update the connected number's display name. */
  async setProfileName(name: string): Promise<void> {
    await this.call(`/chat/updateProfileName/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  }

  /** Update the connected number's "about"/status text. */
  async setProfileStatus(status: string): Promise<void> {
    await this.call(`/chat/updateProfileStatus/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
  }

  /** Update the connected number's avatar (image URL or base64). */
  async setProfilePicture(picture: string): Promise<void> {
    await this.call(`/chat/updateProfilePicture/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ picture }),
    })
  }

  /**
   * Download a message's media (document/image) via Evolution and return it as
   * UTF-8 text. Used to read CSV/employee-list attachments sent over WhatsApp.
   */
  private async fetchMediaText(raw: Record<string, unknown>): Promise<string | null> {
    const resp = await this.call(`/chat/getBase64FromMediaMessage/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ message: { key: raw.key }, convertToMp4: false }),
    })
    const b64 =
      (resp?.base64 as string) ??
      ((resp?.media as Record<string, unknown> | undefined)?.base64 as string | undefined)
    if (!b64 || typeof b64 !== 'string') return null
    return Buffer.from(b64.replace(/^data:.*;base64,/, ''), 'base64').toString('utf8')
  }

  /** Download a message's media (audio/image) via Evolution as raw bytes. */
  private async fetchMediaBuffer(raw: Record<string, unknown>): Promise<Buffer | null> {
    const resp = await this.call(`/chat/getBase64FromMediaMessage/${env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ message: { key: raw.key }, convertToMp4: false }),
    })
    const b64 =
      (resp?.base64 as string) ??
      ((resp?.media as Record<string, unknown> | undefined)?.base64 as string | undefined)
    if (!b64 || typeof b64 !== 'string') return null
    return Buffer.from(b64.replace(/^data:.*;base64,/, ''), 'base64')
  }

  /** Called by the Fastify webhook route for every Evolution event. */
  async handleWebhook(payload: Record<string, unknown>): Promise<void> {
    const event = String(payload.event ?? '').toLowerCase()
    const data = payload.data as Record<string, unknown> | undefined

    if (event.includes('connection')) {
      const state = (data?.state ?? data?.connection) as string | undefined
      if (state) {
        // setReady fires onReady listeners on false→true → flush the outbox so
        // any message queued while offline is sent the instant we reconnect.
        this.setReady(state === 'open')
        if (state === 'open') {
          logger.info('Evolution: conexão ABERTA (online)')
        } else if (state === 'close') {
          // Connection genuinely dropped — fetch a fresh QR (throttled) so the
          // admin can re-pair. 'connecting' is left alone (handshake running).
          logger.warn('Evolution: conexão CAIU (close); buscando novo QR')
          await this.ensureQr().catch(() => {})
        }
      }
      return
    }

    if (event.includes('qrcode')) {
      const qrObj = (data?.qrcode as Record<string, unknown>) ?? data ?? {}
      const base64 = (qrObj.base64 as string) ?? (data?.base64 as string)
      const code = (qrObj.code as string) ?? (data?.code as string)
      if (typeof base64 === 'string' && base64) {
        this.lastQrBase64 = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
      } else if (typeof code === 'string' && code) {
        this.lastQrBase64 = await qrcode.toDataURL(code)
      }
      return
    }

    if (event.includes('messages.upsert') || event.includes('messages_upsert')) {
      // Evolution may send a single message or an array under data / data.messages.
      const items = Array.isArray(data)
        ? data
        : Array.isArray((data as Record<string, unknown>)?.messages)
          ? ((data as Record<string, unknown>).messages as Record<string, unknown>[])
          : data
            ? [data]
            : []
      for (const raw of items as Record<string, unknown>[]) {
        await this.dispatchMessage(raw)
      }
    }
  }

  private async dispatchMessage(raw: Record<string, unknown>): Promise<void> {
    const key = raw.key as Record<string, unknown> | undefined
    if (!key || key.fromMe) return
    const jid = String(key.remoteJid ?? '')
    if (jid.endsWith('@g.us') || jid === 'status@broadcast') return

    const message = raw.message as Record<string, unknown> | undefined
    let text =
      (message?.conversation as string) ??
      ((message?.extendedTextMessage as Record<string, unknown>)?.text as string) ??
      ((message?.imageMessage as Record<string, unknown>)?.caption as string) ??
      ''

    // Voice note: download + transcribe (Whisper) so the AI treats it like text.
    const audioMsg =
      (message?.audioMessage as Record<string, unknown> | undefined) ??
      (((message?.audioWithCaptionMessage as Record<string, unknown>)?.message as
        | Record<string, unknown>
        | undefined)?.audioMessage as Record<string, unknown> | undefined)
    if (audioMsg && !text.trim()) {
      const buf = await this.fetchMediaBuffer(raw).catch((err) => {
        logger.warn({ err: (err as Error).message }, 'Evolution: falha ao baixar áudio')
        return null
      })
      if (buf) {
        const transcript = await transcribeAudio(buf, 'audio.ogg').catch(() => null)
        if (transcript) {
          text = transcript
          logger.info({ chars: transcript.length }, 'Áudio do cliente transcrito')
        } else {
          text =
            'Recebi seu áudio, mas não consegui entender. Pode repetir ou escrever, por favor?'
        }
      }
    }

    // Document attachment (e.g. a CSV with the employee list): download it and
    // inline its text so the AI's cadastrar_beneficiarios flow can parse it.
    const docMsg =
      (message?.documentMessage as Record<string, unknown> | undefined) ??
      (((message?.documentWithCaptionMessage as Record<string, unknown>)?.message as
        | Record<string, unknown>
        | undefined)?.documentMessage as Record<string, unknown> | undefined)
    if (docMsg) {
      const fileName = String(docMsg.fileName ?? docMsg.title ?? 'arquivo')
      const mime = String(docMsg.mimetype ?? '')
      const textual =
        /csv|text|excel|spreadsheet|octet-stream/i.test(mime) || /\.(csv|txt|tsv)$/i.test(fileName)
      const caption = String(docMsg.caption ?? '')
      if (textual) {
        const content = await this.fetchMediaText(raw).catch((err) => {
          logger.warn({ err: (err as Error).message }, 'Evolution: falha ao baixar mídia')
          return null
        })
        if (content && content.trim()) {
          text = `${caption ? caption + '\n\n' : ''}[Arquivo recebido: ${fileName}]\nConteúdo (lista de colaboradores):\n${content.slice(0, 20000)}`
        } else {
          text =
            caption ||
            `Recebi o arquivo ${fileName}, mas não consegui ler o conteúdo. Pode colar a lista (nome,cpf) aqui no chat?`
        }
      } else {
        text =
          caption ||
          `Recebi o arquivo ${fileName} (${mime || 'tipo desconhecido'}). Para cadastrar os colaboradores, envie um CSV (nome,cpf) ou cole a lista aqui no chat.`
      }
    }

    if (!text || !text.trim()) return

    const inbound = {
      from: jid,
      phone: jidToPhone(jid),
      text: text.trim(),
      waMessageId: String(key.id ?? ''),
      pushName: (raw.pushName as string) ?? undefined,
      timestamp: Number(raw.messageTimestamp) || Date.now(),
    }
    for (const h of this.handlers) {
      try {
        await h(inbound)
      } catch (err) {
        logger.error({ err, phone: inbound.phone }, 'Inbound handler error')
      }
    }
  }
}

/** Render any text to a base64 PNG QR (helper for tooling/tests). */
export async function toQrPng(text: string): Promise<string> {
  return qrcode.toDataURL(text)
}
