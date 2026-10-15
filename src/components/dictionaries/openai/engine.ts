import memoizeOne from 'memoize-one'
import {
  SearchFunction,
  GetSrcPageFunction,
  DictSearchResult
} from '../helpers'
import {
  MachineCredentialError,
  MachineTranslatePayload,
  getMTArgs
} from '@/components/MachineTrans/engine'
import {
  commonMachineLanguages,
  createLanguageHelper,
  credentialRequiredResult
} from '../machine-custom'
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_PROMPT,
  DEFAULT_OPENAI_SYSTEM_PROMPT
} from './auth'
import { OpenAILanguage } from './config'
import { PROVIDERS, inferProvider, isProviderID } from './providers/presets'
import { completeChat, streamChat } from './providers/transport'
import { ChatInput, ProviderID, ResolvedLLMConfig } from './providers/types'

export const getTranslator = memoizeOne(() =>
  createLanguageHelper<OpenAILanguage>(
    commonMachineLanguages as ReadonlyArray<OpenAILanguage>
  )
)

export const getSrcPage: GetSrcPageFunction = (text, config) => {
  const resolved = resolveLLMConfig((config.dictAuth as any).openai || {})
  return PROVIDERS[resolved.provider].homepage || resolved.baseUrl
}

export interface OpenAIResult {
  id: 'openai'
  /** model output as constrained HTML; rendered (sanitized) by the View */
  html?: string
  /** raw text, for copy / fallback */
  text?: string
  /** when true, the View streams the result itself via a background port */
  streaming?: boolean
  /** args the View replays to the streaming port (no secrets — apiKey stays in bg) */
  args?: { text: string; from: string; to: string; sentence?: string }
  requireCredential?: boolean
  credentialError?: MachineCredentialError
}

/** Stored `dictAuth.openai`. One key field per provider, so switching models
 * across vendors never loses a key. */
export interface LLMAuthConfig {
  /** 'auto' (infer from the model name) or a ProviderID */
  provider?: string
  model?: string
  /** OpenAI key (kept under its original name) */
  apiKey?: string
  openrouterApiKey?: string
  anthropicApiKey?: string
  geminiApiKey?: string
  deepseekApiKey?: string
  /** endpoint for the custom provider; optional override for Ollama */
  baseUrl?: string
  customApiKey?: string
  systemPrompt?: string
  prompt?: string
  temperature?: string | number
  reasoningEffort?: string
  maxTokens?: string | number
}

export function resolveProviderID(
  provider: unknown,
  model: string
): ProviderID {
  return isProviderID(provider) ? provider : inferProvider(model)
}

/** Merge the stored auth with built-in defaults and route it to a provider. */
export function resolveLLMConfig(auth: LLMAuthConfig = {}): ResolvedLLMConfig {
  const temperature = Number.parseFloat(String(auth.temperature))
  const maxTokens = Number.parseInt(String(auth.maxTokens), 10)
  const model = (auth.model || DEFAULT_OPENAI_MODEL).trim()
  const provider = resolveProviderID(auth.provider, model)
  const preset = PROVIDERS[provider]
  // A user baseUrl only applies where the address is the user's own.
  const ownUrl =
    provider === 'custom' || provider === 'ollama'
      ? (auth.baseUrl || '').trim()
      : ''

  return {
    provider,
    protocol: preset.protocol,
    baseUrl: ownUrl || preset.baseUrl,
    apiKey: preset.keyField
      ? String((auth as any)[preset.keyField] || '').trim()
      : '',
    keyRequired: preset.keyRequired,
    model,
    systemPrompt: auth.systemPrompt || DEFAULT_OPENAI_SYSTEM_PROMPT,
    prompt: auth.prompt || DEFAULT_OPENAI_PROMPT,
    temperature: Number.isFinite(temperature) ? temperature : 0,
    reasoningEffort: (auth.reasoningEffort || '').trim(),
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  }
}

/** Whether the resolved config has everything needed to make a call. */
export function hasCredential(resolved: ResolvedLLMConfig): boolean {
  return (
    !!resolved.model &&
    !!resolved.baseUrl &&
    (!resolved.keyRequired || !!resolved.apiKey)
  )
}

function fillTemplate(
  template: string,
  vars: { text: string; from: string; to: string; sentence: string }
): string {
  return template
    .replace(/\{\{\s*text\s*\}\}/g, vars.text)
    .replace(/\{\{\s*from\s*\}\}/g, vars.from)
    .replace(/\{\{\s*to\s*\}\}/g, vars.to)
    .replace(/\{\{\s*sentence\s*\}\}/g, vars.sentence)
}

/** Max chars of the CONTEXT sentence sent to the model (the selection itself
 * is never capped — a selected paragraph must be translated in full). */
export const MAX_INPUT_LEN = 300

/**
 * Reduce the captured context to the sentence(s) around the selection so we
 * never feed a whole paragraph to the model (slower and costlier). Returns
 * every sentence the selection overlaps — a selection can span more than one —
 * falls back to the first sentence, and caps the length as a final guard.
 *
 * When there is no page context to reduce (quick-search box, word editor, or a
 * failed capture) the caller passes the selection as its own context; the
 * selection is never truncated, so it is handed back whole.
 */
export function extractSentence(selection: string, context: string): string {
  const ctx = (context || '').replace(/\s+/g, ' ').trim()
  if (!ctx) return ''
  const needle = (selection || '').replace(/\s+/g, ' ').trim()

  // Nothing to reduce: the "context" IS the selection.
  if (needle && needle === ctx) return ctx

  const sentences = ctx.match(/[^.?!。？！…]+[.?!。？！…]*/g) || [ctx]
  // Never trim the context below the selection itself — the selection is sent
  // in full anyway, so a shorter context would just be a mangled duplicate.
  const maxLen = Math.max(MAX_INPUT_LEN, needle.length)

  const start = needle ? ctx.indexOf(needle) : -1
  if (start < 0) return sentences[0].trim().slice(0, maxLen)

  const end = start + needle.length
  let offset = 0
  const hit = sentences.filter(s => {
    const sentenceStart = offset
    offset += s.length
    return sentenceStart < end && offset > start
  })
  return (hit.join('') || sentences[0]).trim().slice(0, maxLen)
}

export interface LLMTranslateInput {
  text: string
  from: string
  to: string
  /** the sentence the selected word belongs to; fills `{{sentence}}` */
  sentence?: string
}

/**
 * One-shot translation call. Used by the options "test service" button.
 * Throws on network / http errors.
 */
export async function llmTranslate(
  resolved: ResolvedLLMConfig,
  input: LLMTranslateInput
): Promise<string> {
  return stripCodeFences(
    await completeChat(resolved, buildChat(resolved, input))
  )
}

/** A single English word — the only case where an IPA pronunciation line makes
 * sense (skip phrases, sentences and CJK input). */
export function isSingleEnglishWord(text: string): boolean {
  return /^[a-z][a-z'’-]*$/i.test(text.trim())
}

/** Directive that makes the model prefix its reply with a machine-parseable IPA
 * marker, which the View lifts out into a dedicated pronunciation line. Kept
 * separate from the user's own prompt so it never interferes with it. */
export const IPA_DIRECTIVE =
  'The user is looking up a single English word. On the VERY FIRST line of your ' +
  "reply, before any other text or HTML, output that word's American (US) IPA " +
  'phonetic transcription wrapped EXACTLY as [[IPA:…]] — e.g. [[IPA:/ˈpærɪti/]]. ' +
  'Use US pronunciation only, not UK. If the word is a heteronym with more than ' +
  'one distinct US pronunciation (e.g. live, read, bass, bow), include ALL of ' +
  'them, each followed by a short part-of-speech or sense label in parentheses ' +
  'and separated by " · " — e.g. [[IPA:/lɪv/ (v.) · /laɪv/ (adj.)]]. Give the ' +
  'correct pronunciation of the exact word form as written (an inflected form, ' +
  'not its base form). Then continue with your normal answer.'

/** Build the prompt, choosing the mode-appropriate instructions. */
function buildChat(
  resolved: ResolvedLLMConfig,
  input: LLMTranslateInput
): ChatInput {
  // Everything is driven by the user-configurable systemPrompt/prompt — no
  // mode logic is hardcoded here. The prompt itself decides how to handle
  // words / sentences / Chinese input (see the default systemPrompt).
  // The selection is passed in FULL; only the CONTEXT ({{sentence}}) is trimmed
  // to the sentence around the selection.
  const selection = input.text.trim()
  const sentence = extractSentence(selection, input.sentence || selection)

  const system: string[] = []
  if (resolved.systemPrompt.trim()) {
    system.push(resolved.systemPrompt)
  }
  if (isSingleEnglishWord(selection)) {
    system.push(IPA_DIRECTIVE)
  }
  return {
    system,
    user: fillTemplate(resolved.prompt, {
      text: selection,
      from: input.from,
      to: input.to,
      sentence
    })
  }
}

/**
 * Streaming variant used by the dict View for fast, progressive rendering.
 * Resolves the auth in the background (keeping the apiKey out of page context),
 * streams the response, and calls `onDelta` with the accumulated
 * (fence-stripped) HTML as it grows. Throws on http/network errors; the error
 * carries `.status` so the caller can classify credential failures.
 */
export async function llmStream(
  auth: LLMAuthConfig,
  input: LLMTranslateInput,
  onDelta: (html: string) => void
): Promise<void> {
  const resolved = resolveLLMConfig(auth)
  let content = ''
  await streamChat(resolved, buildChat(resolved, input), delta => {
    content += delta
    onDelta(stripStreamingFences(content))
  })
}

/** Strip a leading ```lang fence and a trailing ``` from partial stream output. */
export function stripStreamingFences(text: string): string {
  return text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '')
}

/** Some models wrap output in ```html ... ``` fences; strip them. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return (fenced ? fenced[1] : trimmed).trim()
}

export const search: SearchFunction<
  OpenAIResult,
  MachineTranslatePayload<OpenAILanguage>
> = async (rawText, config, profile, payload) => {
  const translator = getTranslator()
  const langcodes = translator.getSupportLanguages()
  const { sl, tl, text } = await getMTArgs(
    translator as any,
    rawText,
    (profile.dicts.all as any).openai,
    config,
    payload
  )

  const resolved = resolveLLMConfig((config.dictAuth as any).openai || {})

  if (!hasCredential(resolved)) {
    return credentialRequiredResult('openai', langcodes) as DictSearchResult<
      OpenAIResult
    >
  }

  // Don't call the model here — return immediately so the panel stops
  // spinning, then let the View stream the result over a background port
  // (fast, and the apiKey never leaves the background). Invalid-credential /
  // errors surface through that stream, not here.
  return {
    result: {
      id: 'openai',
      streaming: true,
      args: { text, from: sl, to: tl, sentence: (payload as any).sentence }
    }
  }
}
