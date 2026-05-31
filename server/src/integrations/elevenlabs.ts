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
 * A single line is "data to READ" (not to speak) when it carries figures,
 * money, bullets, links, IDs or codes — things that are awful as audio.
 */
function lineIsData(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/https?:\/\//i.test(t)) return true // links
  if (/^[•\-*]\s|^=>|^›/.test(t)) return true // bullet / arrow rows
  if (/R\$\s?\d|\d+[.,]\d{2}\b/.test(t)) return true // money values
  if (/copia e cola|copie o c[oó]digo|c[oó]digo abaixo|qr code/i.test(t)) return true
  if (/\bID:|^0002\d/.test(t.replace(/\s/g, ''))) return true // ids / PIX payload
  if (/\b(taxa|total|carga|subtotal|valor mensal|vencimento)\b/i.test(t) && /\d/.test(t)) return true
  if (/\S{40,}/.test(t)) return true // long token/code
  // Mostly digits/symbols → read, don't speak.
  const compact = t.replace(/\s/g, '')
  const letters = (t.match(/[a-zA-ZÀ-ÿ]/g) ?? []).length
  if (compact.length > 0 && letters < compact.length * 0.5) return true
  return false
}

export interface DeliverySegment {
  kind: 'audio' | 'text'
  content: string
}

/**
 * Split a reply into ordered segments so each part is delivered in its best
 * form: data/figures/links/codes as TEXT (easy to read/copy), and the natural,
 * conversational sentences as AUDIO. Consecutive lines of the same kind are
 * grouped, preserving order and line breaks. Example:
 *   "Cotação pronta… R$ 9.464,00\n• Taxa…\nQuer seguir para a assinatura?"
 *   → [ {text: "Cotação…\n• Taxa…"}, {audio: "Quer seguir para a assinatura?"} ]
 */
// A WhatsApp voice note should be short and snappy. A segment longer than this
// (≈25-30s spoken) is delivered as TEXT instead — reading a long block aloud was
// producing 2+ minute audios and a bad experience. Long content reads better
// as text anyway.
const MAX_AUDIO_CHARS = 350

export function splitForDelivery(text: string): DeliverySegment[] {
  const lines = text.split('\n')
  const segments: DeliverySegment[] = []
  let buf: string[] = []
  let bufKind: 'audio' | 'text' | null = null

  const flush = () => {
    if (!buf.length || bufKind == null) return
    const content = buf.join('\n').trim()
    // Never generate a giant voice note: demote over-long audio to text.
    const kind = bufKind === 'audio' && content.length > MAX_AUDIO_CHARS ? 'text' : bufKind
    if (content) segments.push({ kind, content })
    buf = []
    bufKind = null
  }

  for (const line of lines) {
    if (!line.trim()) {
      // blank line: keep it within the current block (paragraph spacing)
      if (buf.length) buf.push(line)
      continue
    }
    const kind: 'audio' | 'text' = lineIsData(line) ? 'text' : 'audio'
    if (bufKind && kind !== bufKind) flush()
    bufKind = kind
    buf.push(line)
  }
  flush()
  return segments
}

/**
 * Whole-message check kept for callers that want a quick yes/no. True only when
 * EVERY line is speakable (no data lines at all).
 */
export function isSpeakable(text: string): boolean {
  const segs = splitForDelivery(text)
  return segs.length > 0 && segs.every((s) => s.kind === 'audio')
}

/**
 * Strip WhatsApp/markdown formatting and decorative emojis so the TTS reads
 * clean prose (no "asterisco", no emoji names).
 */
export function cleanForSpeech(text: string): string {
  return (
    text
      .replace(/[*_~`]/g, '') // wa/markdown emphasis
      .replace(/^[•\-]\s*/gm, '') // bullet markers
      // Drop most emojis/pictographs (keep letters, digits, punctuation, accents).
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, '')
      // R$ → "reais" so the TTS doesn't read "erre cifrão"; keep the number.
      .replace(/R\$\s?/g, '')
      // Turn line breaks into sentence pauses (period) so each line gets its own
      // intonation contour instead of being rushed together.
      .replace(/\n+/g, (m) => (/[.!?…:]\s*$/.test(m) ? ' ' : '. '))
      .replace(/[ \t]{2,}/g, ' ')
      // Collapse doubled punctuation that confuses prosody (e.g. ".," → ".").
      .replace(/\.\s*\./g, '.')
      .trim()
  )
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
        // Lower stability = more expressive/varied intonation (questions rise,
        // statements settle); higher style adds emphasis. Tuned for a warm,
        // natural pt-BR assistant rather than a flat narrator.
        voice_settings: {
          stability: 0.32,
          similarity_boost: 0.8,
          style: 0.45,
          use_speaker_boost: true,
          speed: 1.15, // ~15% faster than natural pace
        },
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
