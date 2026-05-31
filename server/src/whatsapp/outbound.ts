import type { WhatsAppGateway } from './gateway.js'

/**
 * Module-level handle to the active WhatsApp gateway so domain code (AI tools,
 * schedulers) can send messages/images without threading the gateway through
 * every call. Set once at boot in index.ts.
 */
let gateway: WhatsAppGateway | null = null

export function registerGateway(g: WhatsAppGateway): void {
  gateway = g
}

/** Whether the WhatsApp transport is currently connected. */
export function isReady(): boolean {
  return gateway?.isReady() ?? false
}

export async function sendText(phone: string, text: string): Promise<void> {
  if (!gateway) return
  await gateway.sendText(phone, text)
}

export async function sendImage(phone: string, base64: string, caption?: string): Promise<void> {
  if (!gateway?.sendImage) {
    // Fallback: if the transport can't send media, at least send the caption.
    if (gateway && caption) await gateway.sendText(phone, caption)
    return
  }
  await gateway.sendImage(phone, base64, caption)
}
