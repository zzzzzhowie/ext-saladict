import { LLMAdapter, LLMError } from './types'

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`
}

/**
 * Whether the model follows the newer OpenAI param conventions
 * (`max_completion_tokens` instead of `max_tokens`, fixed `temperature`).
 * Covers gpt-5/6/7…, o1/o3/o4… reasoning models, bare or `openai/`-prefixed.
 */
export function isNewOpenAIModel(model: string): boolean {
  return /(^|\/)o[1-9]|gpt-[5-9]/i.test(model.trim())
}

const mentions = (error: LLMError, key: string) =>
  error.param ? error.param === key : error.message.toLowerCase().includes(key)

/**
 * OpenAI Chat Completions — also what OpenRouter, Gemini's compat endpoint,
 * DeepSeek, Ollama and most self-hosted servers speak. They differ only in a
 * few knobs, handled per provider here.
 */
export const openaiChatAdapter: LLMAdapter = {
  buildRequest(cfg, chat, stream) {
    const messages = [
      ...chat.system.map(content => ({ role: 'system', content })),
      { role: 'user', content: chat.user }
    ]
    const body: Record<string, any> = { model: cfg.model, messages, stream }
    const newModel = isNewOpenAIModel(cfg.model)
    // Only OpenAI itself renamed the token param; gateways and other vendors
    // take `max_tokens`. Custom endpoints are usually OpenAI proxies.
    const openaiParams = cfg.provider === 'openai' || cfg.provider === 'custom'

    // Newer reasoning models (gpt-5+, o-series) only accept the default
    // temperature; send it only for older models.
    if (!newModel) {
      body.temperature = cfg.temperature
    }
    if (cfg.reasoningEffort) {
      if (cfg.provider === 'openrouter') {
        body.reasoning = { effort: cfg.reasoningEffort }
      } else if (cfg.provider !== 'deepseek') {
        // DeepSeek has no effort knob (reasoning is chosen by model name).
        body.reasoning_effort = cfg.reasoningEffort
      }
    }
    if (cfg.maxTokens > 0) {
      if (openaiParams && newModel) {
        body.max_completion_tokens = cfg.maxTokens
      } else {
        body.max_tokens = cfg.maxTokens
      }
    }

    return {
      url: buildChatCompletionsUrl(cfg.baseUrl),
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body
    }
  },

  parseStreamEvent(data) {
    if (data === '[DONE]') return { done: true }
    // OpenRouter reports mid-stream failures as a top-level `error` chunk.
    if (data && data.error) {
      return { error: data.error.message || 'Stream error' }
    }
    const delta = data?.choices?.[0]?.delta?.content
    return typeof delta === 'string' && delta ? { text: delta } : {}
  },

  parseResponse(json) {
    const content = json?.choices?.[0]?.message?.content
    return typeof content === 'string' ? content : ''
  },

  /**
   * Swap or drop the param the provider rejected. OpenAI names it in
   * `error.param`; others only mention it in the message.
   */
  heal(body, error) {
    if (mentions(error, 'max_tokens') && 'max_tokens' in body) {
      body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
      return true
    }
    if (
      mentions(error, 'max_completion_tokens') &&
      'max_completion_tokens' in body
    ) {
      body.max_tokens = body.max_completion_tokens
      delete body.max_completion_tokens
      return true
    }
    if (mentions(error, 'temperature') && 'temperature' in body) {
      delete body.temperature
      return true
    }
    if (mentions(error, 'reasoning_effort') && 'reasoning_effort' in body) {
      // Some models call the lowest tier "none" instead of "minimal";
      // otherwise the value/param is unsupported, so drop it.
      if (body.reasoning_effort === 'minimal') {
        body.reasoning_effort = 'none'
      } else {
        delete body.reasoning_effort
      }
      return true
    }
    if (mentions(error, 'reasoning') && 'reasoning' in body) {
      delete body.reasoning
      return true
    }
    // An unattributed 400 (e.g. Gemini's "this model only works in thinking
    // mode"): the reasoning knob is the most provider-specific param, so it is
    // the one worth dropping blind.
    if (!error.param) {
      for (const key of ['reasoning_effort', 'reasoning']) {
        if (key in body) {
          delete body[key]
          return true
        }
      }
    }
    return false
  }
}
