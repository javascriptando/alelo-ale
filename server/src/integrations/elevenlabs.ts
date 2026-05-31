import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * ElevenLabs Text-to-Speech. Turns the Alê's replies into a natural voice note
 * so almost every message is delivered as audio on WhatsApp (codes/links stay
 * as text — see `isSpeakable`). Returns base64 MP3 (no data: prefix) or null.
 */

const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech'

export function isElevenLabsConfigured(): boolean {
  return Boolean(env.ELEVENLABS_API_KEY)
}

/**
 * Decide whether a message should be spoken. We DON'T voice messages that carry
 * things a person needs to read/copy: links, the PIX copy-paste code, or any
 * long codey token. Short, natural-language messages are spoken.
 */
export function isSpeakable(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/https?:\/\//i.test(t)) return false // links
  if (/\bpix\b.*\bcola\b|copia e cola/i.test(t)) return false
  // A long run of non-space chars usually means a code / token / PIX payload.
  if (/\S{40,}/.test(t)) return false
  // Mostly digits/symbols (e.g. a bare PIX code) → not speakable.
  const letters = (t.match(/[a-zA-ZÀ-ÿ]/g) ?? []).length
  if (letters < t.replace(/\s/g, '').length * 0.45) return false
  return true
}

/**
 * Strip WhatsApp/markdown formatting and decorative emojis so the TTS reads
 * clean prose (no "asterisco", no emoji names).
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_~`]/g, '') // wa/markdown emphasis
    .replace(/^[•\-]\s*/gm, '') // bullet markers
    // Drop most emojis/pictographs (keep letters, digits, punctuation, accents).
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Synthesize speech for `text`. Returns base64 MP3 or null on failure. */
export async function textToSpeechBase64(text: string): Promise<string | null> {
  if (!isElevenLabsConfigured()) return null
  const speech = cleanForSpeech(text)
  if (!speech) return null
  try {
    const res = await fetch(`${TTS_URL}/${env.ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: speech,
        model_id: env.ELEVENLABS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
      }),
    })
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text() }, 'ElevenLabs TTS falhou')
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.toString('base64')
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ElevenLabs TTS erro')
    return null
  }
}
