import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { logger } from '../config/logger.js'
import type { WhatsAppGateway } from '../whatsapp/gateway.js'

/**
 * WhatsApp connected-number profile (name, "about"/status, avatar) editable by
 * the admin. Persisted to a JSON file (no migration needed) and pushed to the
 * Evolution instance. A sensible default is applied on boot — including a
 * "verified-like" check emoji in the display name, since the real WhatsApp
 * verified badge is granted only by Meta and can't be set via the API.
 */

const FILE = resolve(process.cwd(), 'whatsapp-profile.json')

export interface WhatsappProfile {
  name: string
  about: string
  pictureUrl?: string
}

export const DEFAULT_PROFILE: WhatsappProfile = {
  name: 'Alelo ✅',
  about: 'Atendimento oficial Alelo 💚 Benefícios resolvidos aqui no WhatsApp.',
}

export function getProfile(): WhatsappProfile {
  try {
    return { ...DEFAULT_PROFILE, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Partial<WhatsappProfile>) }
  } catch {
    return { ...DEFAULT_PROFILE }
  }
}

export function saveProfile(p: WhatsappProfile): WhatsappProfile {
  const merged = { ...getProfile(), ...p }
  writeFileSync(FILE, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

/** Push the given profile to the WhatsApp number via the gateway (best-effort). */
export async function applyProfile(gw: WhatsAppGateway, p: WhatsappProfile): Promise<void> {
  if (gw.setProfileName)
    await gw.setProfileName(p.name).catch((e: unknown) => logger.warn({ e }, 'set name'))
  if (gw.setProfileStatus)
    await gw.setProfileStatus(p.about).catch((e: unknown) => logger.warn({ e }, 'set about'))
  if (p.pictureUrl && gw.setProfilePicture)
    await gw.setProfilePicture(p.pictureUrl).catch((e: unknown) => logger.warn({ e }, 'set picture'))
}

/** Apply the saved (or default) profile once the connection is up. */
export async function applySavedProfile(gw: WhatsAppGateway): Promise<void> {
  if (!gw.isReady()) return
  await applyProfile(gw, getProfile())
  logger.info('Perfil do WhatsApp aplicado')
}
