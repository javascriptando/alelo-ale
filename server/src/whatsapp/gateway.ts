/**
 * Transport-agnostic WhatsApp gateway. Baileys today; swapping to the official
 * Meta Cloud API later means only implementing this same interface.
 */
export interface InboundMessage {
  /** raw WhatsApp JID, e.g. "5511999999999@s.whatsapp.net" */
  from: string
  /** normalized phone number, digits only */
  phone: string
  text: string
  waMessageId: string
  pushName?: string
  timestamp: number
}

export type InboundHandler = (msg: InboundMessage) => Promise<void> | void

export interface WhatsAppGateway {
  start(): Promise<void>
  sendText(phone: string, text: string): Promise<void>
  /** Send an image (base64 PNG/JPEG, no data: prefix) with an optional caption. */
  sendImage?(phone: string, base64: string, caption?: string): Promise<void>
  /** Profile customization of the connected number (admin). */
  setProfileName?(name: string): Promise<void>
  setProfileStatus?(status: string): Promise<void>
  setProfilePicture?(picture: string): Promise<void>
  onMessage(handler: InboundHandler): void
  isReady(): boolean
  /** Webhook-based transports (e.g. Evolution API) implement these. */
  handleWebhook?(payload: Record<string, unknown>): Promise<void>
  getQr?(): string | null
  /** Register a callback fired when the connection becomes ready (e.g. flush outbox). */
  onReady?(cb: () => void): void
  refreshConnection?(): Promise<string | null>
  /** Explicit pairing intent: refresh + force a QR if disconnected (admin/QR page). */
  forceQr?(): Promise<void>
  /** Force the connection to restart (recover dead/zombie sessions). */
  reconnect?(): Promise<void>
  /** Log the number out so a different one can be paired (drops the session). */
  disconnect?(): Promise<void>
}

export function jidToPhone(jid: string): string {
  return jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? ''
}

export function phoneToJid(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `${digits}@s.whatsapp.net`
}
