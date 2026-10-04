import { getDomTaskBridge } from './dom-task-bridge'
import {
  buildPhonemeSSML,
  googleTTSUrl,
  toGooglePhonemes
} from '@/components/dictionaries/openai/pronunciation'

const SYNTHESIZE_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize'
const VOICE = { languageCode: 'en-US', name: 'en-US-Wavenet-F' }

/** `${word}|${phonemes}` → `data:` URL. Lookups repeat the same few words, and
 * the toggle-to-stop in AudioManager relies on getting the same src back. */
const cache = new Map<string, string>()
const MAX_CACHE = 200

/**
 * Synthesize `word` read exactly as `ipa` with Google Cloud TTS (WaveNet).
 * Resolves `''` when there is no API key or the IPA can't be expressed in
 * Google's phoneme set; throws on network / API errors.
 */
export async function synthesizeFromIPA(
  word: string,
  ipa: string
): Promise<string> {
  const apiKey = process.env.GOOGLE_CLOUD_TTS_API_KEY
  const phonemes = toGooglePhonemes(ipa)
  if (!apiKey || !phonemes) return ''

  const key = `${word}|${phonemes}`
  const cached = cache.get(key)
  if (cached) return cached

  const res = await fetch(
    `${SYNTHESIZE_URL}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { ssml: buildPhonemeSSML(word, phonemes) },
        voice: VOICE,
        audioConfig: { audioEncoding: 'MP3' }
      })
    }
  )
  if (!res.ok) {
    throw new Error(
      `Cloud TTS ${res.status}: ${await res.text().catch(() => '')}`
    )
  }

  const { audioContent } = await res.json()
  if (!audioContent) return ''

  const src = `data:audio/mpeg;base64,${audioContent}`
  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value)
  }
  cache.set(key, src)
  return src
}

/** Words whose first synthesis is still in flight. A first lookup takes a few
 * hundred ms; a second click in that window would otherwise land right after
 * playback starts and hit the player's "same src = stop" toggle. */
const synthesizing = new Set<string>()

/** Play `word`, read as `ipa` when we can, else via Google Translate TTS. */
export async function playPronunciation({
  text,
  ipa
}: {
  text: string
  ipa?: string
}): Promise<void> {
  let src = ''
  if (ipa) {
    const key = `${text}|${ipa}`
    if (synthesizing.has(key)) return
    synthesizing.add(key)
    try {
      src = await synthesizeFromIPA(text, ipa)
    } catch (e) {
      console.warn('[cloud-tts] falling back to Google Translate TTS:', e)
    } finally {
      synthesizing.delete(key)
    }
  }
  return getDomTaskBridge().playAudio(src || googleTTSUrl(text))
}
