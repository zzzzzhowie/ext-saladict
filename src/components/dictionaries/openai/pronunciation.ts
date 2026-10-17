/**
 * Pronunciation helpers for the OpenAI card's speaker button.
 *
 * Google Translate's TTS reads the bare word and guesses unknown words with its
 * own letter-to-sound rules — rare proper nouns come out wrong ("Kadane" is read
 * /kʌˈdɑːne/ instead of /kəˈdeɪn/). The model already gives us the IPA, so the
 * background synthesizes from it with Google Cloud TTS (SSML `<phoneme>`), and
 * these helpers turn the model's free-form IPA into what that API accepts.
 */

export interface IPAVariant {
  /** transcription as shown to the user, e.g. `/laɪv/` */
  display: string
  /** sense label the model attached to a heteronym reading, e.g. `(adj.)` */
  label: string
  /** raw transcription without delimiters, fed to the synthesizer */
  ipa: string
}

/** Split the model's `[[IPA:…]]` payload into its readings: a heteronym comes
 * as `/lɪv/ (v.) · /laɪv/ (adj.)` (see IPA_DIRECTIVE). */
export function parseIPAVariants(raw: string): IPAVariant[] {
  return raw
    .split(/\s*[·•;]\s*/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const m = /[/[]([^/\]]+)[/\]]/.exec(part)
      if (!m) return { display: part, label: '', ipa: part }
      const label = (
        part.slice(0, m.index) + part.slice(m.index + m[0].length)
      ).trim()
      return { display: m[0], label, ipa: m[1].trim() }
    })
}

/** The en-US IPA inventory Google Cloud TTS accepts in `<phoneme>`:
 * https://cloud.google.com/text-to-speech/docs/phonemes */
const GOOGLE_EN_US_CHARS = /^[pbtdkɡmnŋfvszθðʃʒhlɹʧʤjwæɑəɚɛɪiɔʊuʌaeoˈˌ.ː]+$/

const VOWEL = 'aeiouæɑɒɔəɚɛɜɪʊʌ'

/**
 * Map a (US) IPA transcription onto Google's en-US phoneme set. Models write
 * broad transcriptions (`r`, `g`, `ɝ`, `tʃ`, unmarked length), Google wants
 * `ɹ`, `ɡ`, `ɚ`, `ʧ`, `iː`… Returns `''` when the result still contains a
 * symbol Google doesn't know, so the caller falls back to plain-text TTS
 * instead of synthesizing garbage.
 */
export function toGooglePhonemes(ipa: string): string {
  let s = ipa
    // alternatives ("ˈdeɪtə, ˈdætə") — speak the first
    .split(/[,，]|\s+or\s+/)[0]
    .replace(/[/[\]()\s]/g, '')
    // combining marks: tie bars, syllabic/nasal/devoicing diacritics
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ʰʲʷ‿ˑ-]/g, '')
    .replace(/['’′]/g, 'ˈ')
    .replace(/:/g, 'ː')

  s = s
    .replace(/tʃ/g, 'ʧ')
    .replace(/dʒ/g, 'ʤ')
    .replace(/r/g, 'ɹ')
    .replace(/g/g, 'ɡ')
    .replace(/ɾ/g, 't')
    .replace(/ʔ/g, 't')
    .replace(/ɫ/g, 'l')
    .replace(/ʍ/g, 'w')
    .replace(/[ᵻɨ]/g, 'ɪ')
    .replace(/ɐ/g, 'ə')
    .replace(/ʉ/g, 'u')
    .replace(/ɒ/g, 'ɑ')
    // r-colored vowels: ɝ, ɜr, and ər at a syllable end all become ɚ
    .replace(/ɝ|ɜː?ɹ?/g, 'ɚ')
    .replace(new RegExp(`əɹ(?![${VOWEL}])`, 'g'), 'ɚ')
    // diphthongs spelled with plain vowels
    .replace(/ai|ɑɪ/g, 'aɪ')
    .replace(/au|ɑʊ/g, 'aʊ')
    .replace(/ei/g, 'eɪ')
    .replace(/[oɔ]i/g, 'ɔɪ')
    .replace(/ou|əʊ/g, 'oʊ')
    .replace(/a(?![ɪʊ])/g, 'ɑ')
    .replace(/e(?!ɪ)/g, 'ɛ')
    .replace(/o(?!ʊ)/g, 'oʊ')
    // Google's long vowels carry an explicit length mark
    .replace(/([iuɑ])(?!ː)/g, '$1ː')
    .replace(/ɔ(?![ːɪ])/g, 'ɔː')

  return GOOGLE_EN_US_CHARS.test(s) ? s : ''
}

const escapeXML = (text: string): string =>
  text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export function buildPhonemeSSML(word: string, phonemes: string): string {
  return (
    `<speak><phoneme alphabet="ipa" ph="${escapeXML(phonemes)}">` +
    `${escapeXML(word)}</phoneme></speak>`
  )
}

/** Tokenless Google Translate TTS endpoint: reads the exact word and needs no
 * `tk` token, so it works from the MV3 background service worker. The fallback
 * when there is no usable IPA or no Cloud TTS key. */
export const googleTTSUrl = (word: string): string =>
  'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' +
  encodeURIComponent(word)
