import { LLMAdapter } from './types'

const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic requires `max_tokens`; used when the user set no cap. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Claude models before 4.7 still take `temperature` and predate
 * `output_config.effort` (Sonnet/Haiku 4.5 reject it). From 4.7 on it's the
 * reverse: non-default sampling params are a 400 and effort is the only knob.
 */
export function isLegacyClaudeModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return (
    /^claude-(2|3|instant)/.test(m) ||
    /^claude-(opus|sonnet|haiku)-4(-[0-6])?(-\d{8})?$/.test(m)
  )
}

/** Map the shared reasoningEffort onto Claude's effort levels. Current Claude
 * models can't turn thinking fully off, so none/minimal mean the lowest tier. */
export function toClaudeEffort(reasoningEffort: string): string {
  const e = reasoningEffort.trim().toLowerCase()
  if (e === 'none' || e === 'minimal') return 'low'
  return CLAUDE_EFFORTS.includes(e) ? e : ''
}

export function buildMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/messages$/i.test(trimmed) ? trimmed : `${trimmed}/messages`
}

/** Anthropic Messages API, called directly from the extension. */
export const anthropicAdapter: LLMAdapter = {
  buildRequest(cfg, chat, stream) {
    const body: Record<string, any> = {
      model: cfg.model,
      max_tokens:
        cfg.maxTokens > 0 ? cfg.maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: chat.user }],
      stream
    }
    if (chat.system.length > 0) {
      body.system = chat.system.map(text => ({ type: 'text', text }))
    }
    if (isLegacyClaudeModel(cfg.model)) {
      body.temperature = cfg.temperature
    } else {
      const effort = toClaudeEffort(cfg.reasoningEffort)
      if (effort) {
        body.output_config = { effort }
      }
    }

    return {
      url: buildMessagesUrl(cfg.baseUrl),
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        // Requests from an extension carry an Origin header; without this the
        // API rejects them as browser CORS calls.
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {})
      },
      body
    }
  },

  parseStreamEvent(data) {
    switch (data?.type) {
      case 'content_block_delta':
        // thinking_delta / signature_delta blocks are skipped
        return data.delta?.type === 'text_delta' && data.delta.text
          ? { text: data.delta.text }
          : {}
      case 'message_stop':
        return { done: true }
      case 'error':
        return { error: data.error?.message || 'Anthropic stream error' }
    }
    return {}
  },

  parseResponse(json) {
    const blocks: any[] = Array.isArray(json?.content) ? json.content : []
    return blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
  },

  heal(body, error) {
    const message = error.message.toLowerCase()
    if (message.includes('temperature') && 'temperature' in body) {
      delete body.temperature
      return true
    }
    if (
      (message.includes('effort') || message.includes('output_config')) &&
      'output_config' in body
    ) {
      delete body.output_config
      return true
    }
    return false
  }
}
