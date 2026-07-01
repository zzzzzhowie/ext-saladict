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
  credentialErrorResult,
  credentialRequiredResult,
  getAxiosCredentialError
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
  const {
    baseUrl,
    apiKey,
    model,
    systemPrompt,
    prompt,
    temperature,
    reasoningEffort,
    maxTokens
  } = input

  const messages: Array<{ role: string; content: string }> = []
  if (systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({
    role: 'user',
    content: fillTemplate(prompt, {
      text: input.text,
      from: input.from,
      to: input.to,
      sentence: input.sentence || input.text
    })
  })

  const newModel = isNewOpenAIModel(model)

  const body: Record<string, any> = {
    model,
    messages,
    stream: false
  }
  // Newer OpenAI reasoning models (gpt-5+, o-series) only accept the default
  // temperature (1); any other value 400s. Only send it for older models.
  if (!newModel) {
    body.temperature = temperature
  }
  // Only send these when set: unsupported params make some providers 400.
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort
  }
  if (maxTokens > 0) {
    // Newer models renamed `max_tokens` -> `max_completion_tokens`.
    if (newModel) {
      body.max_completion_tokens = maxTokens
    } else {
      body.max_tokens = maxTokens
    }
  }

  const url = buildChatCompletionsUrl(baseUrl)
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  }

  const response = await postChatCompletions(url, body, headers)

  const content = response.data?.choices?.[0]?.message?.content
  return typeof content === 'string' ? stripCodeFences(content) : ''
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

  try {
    const html = await openaiTranslate({
      ...resolved,
      text,
      from: sl,
      to: tl,
      sentence: (payload as any).sentence
    })
    return { result: { id: 'openai', html, text: html } }
  } catch (e) {
    const credentialError = getAxiosCredentialError(e)
    if (credentialError) {
      return credentialErrorResult(
        'openai',
        credentialError,
        langcodes
      ) as DictSearchResult<OpenAIResult>
    }
    return { result: { id: 'openai', html: '', text: '' } }
  }
}
