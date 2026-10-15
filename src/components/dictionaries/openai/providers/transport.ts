import { anthropicAdapter } from './anthropic'
import {
  applyPatch,
  diffBody,
  getPatch,
  healKey,
  savePatch
} from './heal-cache'
import { openaiChatAdapter } from './openai-chat'
import {
  ChatInput,
  LLMAdapter,
  LLMError,
  Protocol,
  ResolvedLLMConfig
} from './types'

const ADAPTERS: { [p in Protocol]: LLMAdapter } = {
  'openai-chat': openaiChatAdapter,
  anthropic: anthropicAdapter
}

/** Bounded so a misclassified model costs a few fast 400s, not a loop. */
const MAX_HEALS = 3

function readError(json: any): LLMError {
  // OpenAI/OpenRouter/Anthropic: `{ error: {…} }`; Gemini wraps it in an array.
  const err = Array.isArray(json) ? json[0]?.error : json?.error
  return {
    param: typeof err?.param === 'string' ? err.param : undefined,
    message:
      (typeof err === 'string' ? err : err?.message) || json?.message || ''
  }
}

/**
 * POST to the provider, healing a rejected param and retrying on a 400.
 * A heal that worked is remembered (heal-cache) and applied up front next
 * time. Throws an Error carrying `.status` (so callers can classify
 * credential failures) and the provider's own message.
 */
async function post(
  cfg: ResolvedLLMConfig,
  chat: ChatInput,
  stream: boolean
): Promise<Response> {
  const adapter = ADAPTERS[cfg.protocol]
  const req = adapter.buildRequest(cfg, chat, stream)
  const original = { ...req.body }
  const key = healKey(cfg)
  let cached = await getPatch(key)
  if (cached) applyPatch(req.body, cached)
  let healed = false

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      // The key is the only auth. Without this the extension also sends the
      // user's site login cookies (e.g. openrouter.ai's session) along.
      credentials: 'omit'
    })
    if (res.ok) {
      if (healed) savePatch(key, diffBody(original, req.body))
      return res
    }

    const text = await res.text().catch(() => '')
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON error body */
    }
    const error = readError(json)
    if (res.status === 400) {
      if (attempt < MAX_HEALS && adapter.heal(req.body, error)) {
        healed = true
        continue
      }
      if (cached) {
        // The remembered patch no longer fits this model: forget it and
        // retry the request as built.
        savePatch(key, null)
        cached = undefined
        healed = false
        req.body = { ...original }
        continue
      }
    }

    const err: any = new Error(
      error.message || `AI request failed (${res.status})`
    )
    err.status = res.status
    throw err
  }
}

export async function completeChat(
  cfg: ResolvedLLMConfig,
  chat: ChatInput
): Promise<string> {
  const res = await post(cfg, chat, false)
  return ADAPTERS[cfg.protocol].parseResponse(await res.json())
}

/** Stream the reply, calling `onText` with each text delta. */
export async function streamChat(
  cfg: ResolvedLLMConfig,
  chat: ChatInput,
  onText: (delta: string) => void
): Promise<void> {
  const adapter = ADAPTERS[cfg.protocol]
  const res = await post(cfg, chat, true)
  if (!res.body) {
    throw new Error('AI request returned no body')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      // `event:` lines are redundant: Anthropic repeats the type in the data.
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      let data: any = payload
      if (payload !== '[DONE]') {
        try {
          data = JSON.parse(payload)
        } catch {
          continue // keep-alive comment or partial chunk
        }
      }
      const event = adapter.parseStreamEvent(data)
      if (event.error) throw new Error(event.error)
      if (event.text) onText(event.text)
      if (event.done) return
    }
  }
}
