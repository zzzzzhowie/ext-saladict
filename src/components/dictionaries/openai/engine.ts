import axios from 'axios'
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
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_PROMPT,
  DEFAULT_OPENAI_SYSTEM_PROMPT
} from './auth'
import { OpenAILanguage } from './config'

export const getTranslator = memoizeOne(() =>
  createLanguageHelper<OpenAILanguage>(
    commonMachineLanguages as ReadonlyArray<OpenAILanguage>
  )
)

export const getSrcPage: GetSrcPageFunction = () =>
  'https://platform.openai.com'

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

export interface OpenAIAuthConfig {
  baseUrl?: string
  apiKey?: string
  model?: string
  systemPrompt?: string
  prompt?: string
  temperature?: string | number
  reasoningEffort?: string
  maxTokens?: string | number
}

export interface ResolvedOpenAIConfig {
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  prompt: string
  temperature: number
  /** '' means don't send `reasoning_effort` (safe for non-reasoning models) */
  reasoningEffort: string
  /** 0 means don't send `max_tokens` (no limit) */
  maxTokens: number
}

/** Merge the stored auth with built-in defaults. */
export function resolveOpenAIConfig(
  auth: OpenAIAuthConfig = {}
): ResolvedOpenAIConfig {
  const temperature = Number.parseFloat(String(auth.temperature))
  const maxTokens = Number.parseInt(String(auth.maxTokens), 10)

  return {
    baseUrl: (auth.baseUrl || DEFAULT_OPENAI_BASE_URL).trim(),
    apiKey: (auth.apiKey || '').trim(),
    model: (auth.model || DEFAULT_OPENAI_MODEL).trim(),
    systemPrompt: auth.systemPrompt || DEFAULT_OPENAI_SYSTEM_PROMPT,
    prompt: auth.prompt || DEFAULT_OPENAI_PROMPT,
    temperature: Number.isFinite(temperature) ? temperature : 0,
    reasoningEffort: (auth.reasoningEffort || '').trim(),
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  }
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
 * Reduce the captured context to the single sentence around the selection so
 * we never feed a whole paragraph to the model (slower and costlier). Picks
 * the sentence that contains the selected text; falls back to the first
 * sentence, and caps the length as a final guard.
 */
export function extractSentence(selection: string, context: string): string {
  const ctx = (context || '').replace(/\s+/g, ' ').trim()
  if (!ctx) return ''
  const sentences = ctx.match(/[^.?!。？！…]+[.?!。？！…]*/g) || [ctx]
  const needle = (selection || '').replace(/\s+/g, ' ').trim()
  const hit =
    (needle && sentences.find(s => s.includes(needle))) || sentences[0]
  return hit.trim().slice(0, MAX_INPUT_LEN)
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`
}

export interface OpenAITranslateInput extends ResolvedOpenAIConfig {
  text: string
  from: string
  to: string
  /** the sentence the selected word belongs to; fills `{{sentence}}` */
  sentence?: string
}

/**
 * Pure translation call against an OpenAI-compatible `/chat/completions`
 * endpoint. Reused by both the dict `search` and the options "test service"
 * button. Throws on network / http errors.
 */
export async function openaiTranslate(
  input: OpenAITranslateInput
): Promise<string> {
  const messages = buildChatMessages(input, input)
  const body = buildChatBody(input, messages, false)

  const response = await postChatCompletions(
    buildChatCompletionsUrl(input.baseUrl),
    body,
    buildChatHeaders(input.apiKey)
  )

  const content = response.data?.choices?.[0]?.message?.content
  return typeof content === 'string' ? stripCodeFences(content) : ''
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
  "reply, before any other text or HTML, output that word's IPA phonetic " +
  'transcription wrapped EXACTLY as [[IPA:…]] — e.g. [[IPA:UK /ˈpærɪti/ US ' +
  '/ˈperəti/]] (drop an accent label if both are identical). Give the correct ' +
  'pronunciation of the exact word form as written (e.g. an inflected form, not ' +
  'its base form). Then continue with your normal answer.'

/** Build the chat `messages` array, choosing the mode-appropriate prompts. */
function buildChatMessages(
  resolved: ResolvedOpenAIConfig,
  input: { text: string; from: string; to: string; sentence?: string }
): Array<{ role: string; content: string }> {
  // Everything is driven by the user-configurable systemPrompt/prompt — no
  // mode logic is hardcoded here. The prompt itself decides how to handle
  // words / sentences / Chinese input (see the default systemPrompt).
  // The selection is passed in FULL; only the CONTEXT ({{sentence}}) is trimmed
  // to the sentence around the selection.
  const selection = input.text.trim()
  const sentence = extractSentence(selection, input.sentence || selection)

  const messages: Array<{ role: string; content: string }> = []
  if (resolved.systemPrompt.trim()) {
    messages.push({ role: 'system', content: resolved.systemPrompt })
  }
  if (isSingleEnglishWord(selection)) {
    messages.push({ role: 'system', content: IPA_DIRECTIVE })
  }
  messages.push({
    role: 'user',
    content: fillTemplate(resolved.prompt, {
      text: selection,
      from: input.from,
      to: input.to,
      sentence
    })
  })
  return messages
}

/** Build the request body, applying newer-model param conventions. */
function buildChatBody(
  resolved: ResolvedOpenAIConfig,
  messages: Array<{ role: string; content: string }>,
  stream: boolean
): Record<string, any> {
  const newModel = isNewOpenAIModel(resolved.model)
  const body: Record<string, any> = { model: resolved.model, messages, stream }
  // Newer reasoning models (gpt-5+, o-series) only accept the default
  // temperature; send it only for older models.
  if (!newModel) {
    body.temperature = resolved.temperature
  }
  if (resolved.reasoningEffort) {
    body.reasoning_effort = resolved.reasoningEffort
  }
  if (resolved.maxTokens > 0) {
    // Newer models renamed `max_tokens` -> `max_completion_tokens`.
    if (newModel) {
      body.max_completion_tokens = resolved.maxTokens
    } else {
      body.max_tokens = resolved.maxTokens
    }
  }
  return body
}

function buildChatHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  }
}

/**
 * Streaming variant used by the dict View for fast, progressive rendering.
 * Resolves the auth in the background (keeping the apiKey out of page context),
 * streams the OpenAI SSE response, and calls `onDelta` with the accumulated
 * (fence-stripped) HTML as it grows. Throws on http/network errors; the error
 * carries `.status` so the caller can classify credential failures.
 */
export interface OpenAIStreamInput {
  text: string
  from: string
  to: string
  sentence?: string
}

export async function openaiStream(
  auth: OpenAIAuthConfig,
  input: OpenAIStreamInput,
  onDelta: (html: string) => void
): Promise<void> {
  const resolved = resolveOpenAIConfig(auth)
  const messages = buildChatMessages(resolved, input)
  const body = buildChatBody(resolved, messages, true)

  const res = await fetch(buildChatCompletionsUrl(resolved.baseUrl), {
    method: 'POST',
    headers: buildChatHeaders(resolved.apiKey),
    body: JSON.stringify(body)
  })

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '')
    let apiMessage = ''
    try {
      apiMessage = JSON.parse(errText)?.error?.message || ''
    } catch {
      /* non-JSON error body */
    }
    const err: any = new Error(
      apiMessage || `OpenAI request failed (${res.status})`
    )
    err.status = res.status
    throw err
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data)
        const delta = json.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) {
          content += delta
          onDelta(stripStreamingFences(content))
        }
      } catch {
        /* keep-alive comment or partial chunk */
      }
    }
  }
}

/** Strip a leading ```lang fence and a trailing ``` from partial stream output. */
export function stripStreamingFences(text: string): string {
  return text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '')
}

/**
 * Whether the model follows the newer OpenAI param conventions
 * (`max_completion_tokens` instead of `max_tokens`, fixed `temperature`).
 * Covers gpt-5/6/7…, o1/o3/o4… reasoning models.
 */
export function isNewOpenAIModel(model: string): boolean {
  return /(^|\/)o[1-9]|gpt-[5-9]/i.test(model.trim())
}

/**
 * POST to `/chat/completions`, self-healing across provider quirks: if the
 * provider rejects `max_tokens` / `max_completion_tokens` / `temperature` with
 * a 400, swap or drop that param and retry once. Steady-state calls (model
 * classified correctly up front) never hit the retry path. On final failure,
 * rethrows with the provider's real error message.
 */
async function postChatCompletions(
  url: string,
  body: Record<string, any>,
  headers: Record<string, string>,
  attempt = 0
): Promise<any> {
  try {
    return await axios.post(url, body, { headers })
  } catch (e) {
    const apiError = (e as any)?.response?.data?.error
    const param: string | undefined = apiError?.param

    if (attempt < 3 && param) {
      if (param === 'max_tokens' && 'max_tokens' in body) {
        body.max_completion_tokens = body.max_tokens
        delete body.max_tokens
        return postChatCompletions(url, body, headers, attempt + 1)
      }
      if (
        param === 'max_completion_tokens' &&
        'max_completion_tokens' in body
      ) {
        body.max_tokens = body.max_completion_tokens
        delete body.max_completion_tokens
        return postChatCompletions(url, body, headers, attempt + 1)
      }
      if (param === 'temperature' && 'temperature' in body) {
        delete body.temperature
        return postChatCompletions(url, body, headers, attempt + 1)
      }
      if (param === 'reasoning_effort' && 'reasoning_effort' in body) {
        // Some models call the lowest tier "none" instead of "minimal";
        // otherwise the value/param is unsupported, so drop it.
        if (body.reasoning_effort === 'minimal') {
          body.reasoning_effort = 'none'
        } else {
          delete body.reasoning_effort
        }
        return postChatCompletions(url, body, headers, attempt + 1)
      }
    }

    // Surface the provider's actual message instead of axios's generic "status
    // code 400". Keep the original response so credential detection still works.
    if (apiError?.message && e instanceof Error) {
      e.message = apiError.message
    }
    throw e
  }
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

  const resolved = resolveOpenAIConfig((config.dictAuth as any).openai || {})

  if (!resolved.apiKey || !resolved.baseUrl || !resolved.model) {
    return credentialRequiredResult('openai', langcodes) as DictSearchResult<
      OpenAIResult
    >
  }

  // Don't call OpenAI here — return immediately so the panel stops spinning,
  // then let the View stream the result over a background port (fast, and the
  // apiKey never leaves the background). Invalid-credential/errors surface
  // through that stream, not here.
  return {
    result: {
      id: 'openai',
      streaming: true,
      args: { text, from: sl, to: tl, sentence: (payload as any).sentence }
    }
  }
}
