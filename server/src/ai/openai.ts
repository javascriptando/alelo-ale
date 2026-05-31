import OpenAI, { toFile } from 'openai'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })

/**
 * Transcribe a voice note (client sent audio on WhatsApp) to text via Whisper,
 * so the AI flow treats it exactly like a typed message. `audio` is the raw
 * bytes (ogg/opus/mp3). Returns the transcript or null on failure.
 */
export async function transcribeAudio(audio: Buffer, filename = 'audio.ogg'): Promise<string | null> {
  try {
    const file = await toFile(audio, filename)
    const r = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'pt',
    })
    return r.text?.trim() || null
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Whisper transcrição falhou')
    return null
  }
}

// Preference order — newest/most capable first. The app picks the first one
// that actually exists on the account (queried at runtime), so it self-adapts
// as OpenAI ships new models without code changes.
// Ordered for a latency-sensitive WhatsApp agent with tool-calling: newest
// general chat models first, avoiding the slow/expensive `-pro` and the
// code-specialized `-codex` variants. Auto-detected against the account so new
// releases are picked up without code changes.
const PREFERENCE = [
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.5',
  'gpt-5',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
]

let cachedModel: string | null = null

export async function resolveModel(): Promise<string> {
  if (env.OPENAI_MODEL) return env.OPENAI_MODEL
  if (cachedModel) return cachedModel
  try {
    const list = await openai.models.list()
    const available = new Set(list.data.map((m) => m.id))
    for (const pref of PREFERENCE) {
      if (available.has(pref)) {
        cachedModel = pref
        logger.info({ model: pref }, 'OpenAI model auto-selected')
        return pref
      }
    }
    // Fallback: any gpt-* chat model present on the account
    const anyGpt = list.data.map((m) => m.id).find((id) => id.startsWith('gpt-'))
    cachedModel = anyGpt ?? 'gpt-4o-mini'
    logger.warn({ model: cachedModel }, 'No preferred model found; using fallback')
    return cachedModel
  } catch (err) {
    logger.error({ err }, 'Failed to list OpenAI models; defaulting to gpt-4o-mini')
    return 'gpt-4o-mini'
  }
}
