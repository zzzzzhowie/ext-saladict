import { TextEncoder, TextDecoder } from 'util'

// jsdom doesn't provide these globals; the streaming engine + tests need them.
;(global as any).TextEncoder = (global as any).TextEncoder || TextEncoder
;(global as any).TextDecoder = (global as any).TextDecoder || TextDecoder
import { getDefaultConfig } from '@/app-config'
import { getDefaultProfile } from '@/app-config/profiles'
import {
  IPA_DIRECTIVE,
  extractSentence,
  llmStream,
  llmTranslate,
  resolveLLMConfig,
  search,
  stripCodeFences,
  stripStreamingFences
} from '@/components/dictionaries/openai/engine'
import {
  buildChatCompletionsUrl,
  isNewOpenAIModel
} from '@/components/dictionaries/openai/providers/openai-chat'
import { inferProvider } from '@/components/dictionaries/openai/providers/presets'
import { isLegacyClaudeModel } from '@/components/dictionaries/openai/providers/anthropic'
import { DEFAULT_OPENAI_MODEL } from '@/components/dictionaries/openai/auth'
import {
  HEAL_CACHE_KEY,
  applyPatch,
  diffBody,
  healKey
} from '@/components/dictionaries/openai/providers/heal-cache'

interface MockReply {
  status?: number
  json?: any
  /** SSE chunks for a streaming reply */
  sse?: string[]
}

interface FetchCall {
  url: string
  body: any
  headers: Record<string, string>
}

const origFetch = (global as any).fetch

/** Replace global fetch; `reply` gets each request (1-based call index). */
function mockFetch(
  reply: (call: FetchCall, n: number) => MockReply
): FetchCall[] {
  const calls: FetchCall[] = []
  ;(global as any).fetch = jest.fn(async (url: string, init: any) => {
    const call = { url, body: JSON.parse(init.body), headers: init.headers }
    calls.push(call)
    const r = reply(call, calls.length)
    const status = r.status || 200
    const encoder = new TextEncoder()
    let i = 0
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
      body: r.sse
        ? {
            getReader: () => ({
              read: async () =>
                i < r.sse!.length
                  ? { done: false, value: encoder.encode(r.sse![i++]) }
                  : { done: true, value: undefined }
            })
          }
        : null
    }
  })
  return calls
}

const chatReply = (content: string): MockReply => ({
  json: { choices: [{ message: { content } }] }
})

const translate = (
  auth: Parameters<typeof resolveLLMConfig>[0],
  input: { text: string; from?: string; to?: string; sentence?: string }
) =>
  llmTranslate(resolveLLMConfig(auth), {
    from: 'en',
    to: 'zh-CN',
    ...input
  })

/** In-memory storage.local, so heals remembered by one test don't leak. */
let storageData: Record<string, any> = {}

beforeEach(() => {
  storageData = {}
  const local = (global as any).browser.storage.local
  local.get.callsFake(async (key: string) => ({ [key]: storageData[key] }))
  local.set.callsFake(async (items: Record<string, any>) => {
    Object.assign(storageData, items)
  })
})

afterEach(() => {
  ;(global as any).fetch = origFetch
  ;(global as any).browser.flush()
})

/** Let fire-and-forget cache writes land. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('openai translator', () => {
  it('normalizes chat completions URLs', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
    expect(buildChatCompletionsUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
    expect(
      buildChatCompletionsUrl('https://api.openai.com/v1/chat/completions')
    ).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('falls back to defaults for empty fields', () => {
    const resolved = resolveLLMConfig({ apiKey: 'sk-xxx' })
    expect(resolved.model).toBe(DEFAULT_OPENAI_MODEL)
    expect(resolved.provider).toBe('openai')
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1')
    expect(resolved.temperature).toBe(0)
  })

  it('parses temperature strings', () => {
    expect(resolveLLMConfig({ temperature: '0.7' }).temperature).toBe(0.7)
    expect(resolveLLMConfig({ temperature: 'not-a-number' }).temperature).toBe(
      0
    )
  })

  it('fills prompt placeholders and reads the response content', async () => {
    const calls = mockFetch(() => chatReply('你好，世界！'))

    const translated = await translate(
      { apiKey: 'sk-xxx', systemPrompt: 'SYS', prompt: '{{text}} -> {{to}}' },
      { text: 'Hello, world!' }
    )

    const { url, body, headers } = calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(headers.Authorization).toBe('Bearer sk-xxx')
    expect(body.model).toBe('gpt-5.4-nano')
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].content).toContain('Hello, world!')
    expect(body.messages[1].content).toContain('zh-CN')
    // omitted when unset
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
    expect(translated).toBe('你好，世界！')
  })

  it('fills the {{sentence}} placeholder with the selection context', async () => {
    const calls = mockFetch(() => chatReply('河岸'))

    const translated = await translate(
      { apiKey: 'sk-xxx', prompt: '{{text}} in {{sentence}}' },
      { text: 'bank', sentence: 'The bank of the river was muddy.' }
    )

    expect(calls[0].body.messages[1].content).toContain(
      'The bank of the river was muddy.'
    )
    expect(translated).toBe('河岸')
  })

  it('uses max_completion_tokens and omits temperature for new models', async () => {
    const calls = mockFetch(() => chatReply('ok'))

    await translate(
      { apiKey: 'sk-xxx', reasoningEffort: 'minimal', maxTokens: '256' },
      { text: 'bank' }
    )

    const { body } = calls[0]
    expect(body.reasoning_effort).toBe('minimal')
    // gpt-5.4-nano is a "new" model: renamed param, no temperature
    expect(body.max_completion_tokens).toBe(256)
    expect(body.max_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })

  it('uses max_tokens and sends temperature for legacy models', async () => {
    const calls = mockFetch(() => chatReply('ok'))

    await translate(
      { apiKey: 'sk-xxx', model: 'gpt-4o-mini', maxTokens: '256' },
      { text: 'bank' }
    )

    const { body } = calls[0]
    expect(body.max_tokens).toBe(256)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.temperature).toBe(0)
  })

  it('classifies new vs legacy OpenAI models', () => {
    expect(isNewOpenAIModel('gpt-5.4-nano')).toBe(true)
    expect(isNewOpenAIModel('gpt-5.4-mini')).toBe(true)
    expect(isNewOpenAIModel('o3-mini')).toBe(true)
    expect(isNewOpenAIModel('openai/gpt-5.4-nano')).toBe(true)
    expect(isNewOpenAIModel('gpt-4o-mini')).toBe(false)
    expect(isNewOpenAIModel('gpt-3.5-turbo')).toBe(false)
  })

  it('feeds only the current sentence, not the whole paragraph', () => {
    const paragraph =
      'Sentence one is here. The bank of the river was muddy. Sentence three follows.'
    expect(extractSentence('bank', paragraph)).toBe(
      'The bank of the river was muddy.'
    )
    // collapses whitespace and falls back to the first sentence
    expect(extractSentence('', 'First one.  Second two.')).toBe('First one.')
    // caps very long input
    expect(extractSentence('x', 'x'.repeat(500)).length).toBeLessThanOrEqual(
      300
    )
  })

  it('keeps the whole selection when there is no context to reduce', () => {
    // Quick-search box / word editor: no page selection, so the caller passes
    // the selection as its own context. It must come back untouched.
    const multiSentence =
      "However, my illustration will hold the stance as user's request " +
      '(primarily business logic). As for how it translates engineering ' +
      'changes on the VM side, and how it will impact the platform side ' +
      "actions, it's more up to you guys to make them clear."
    expect(extractSentence(multiSentence, multiSentence)).toBe(multiSentence)
    // even past the context cap
    const long = 'A sentence. ' + 'padding words '.repeat(100)
    expect(extractSentence(long, long)).toBe(long.replace(/\s+/g, ' ').trim())
  })

  it('returns every sentence a multi-sentence selection spans', () => {
    const paragraph =
      'Sentence one is here. The bank of the river was muddy. Sentence three follows. Sentence four ends it.'
    expect(
      extractSentence(
        'The bank of the river was muddy. Sentence three follows.',
        paragraph
      )
    ).toBe('The bank of the river was muddy. Sentence three follows.')
    // a partial span still pulls in both sentences it touches
    expect(extractSentence('river was muddy. Sentence three', paragraph)).toBe(
      'The bank of the river was muddy. Sentence three follows.'
    )
  })

  it('translates a whole selected paragraph in full (never truncates it)', async () => {
    const paragraph = (
      'This is a long paragraph. ' + 'word '.repeat(200)
    ).trim()
    const calls = mockFetch(() => chatReply('ok'))

    await translate(
      { apiKey: 'sk-xxx', prompt: '{{text}}' },
      { text: paragraph, sentence: paragraph }
    )

    const messages = calls[0].body.messages
    // the full selection must be present, uncut
    expect(messages[messages.length - 1].content).toContain(paragraph)
  })

  it('only sends the current sentence to the model', async () => {
    const calls = mockFetch(() => chatReply('ok'))

    await translate(
      { apiKey: 'sk-xxx', prompt: '{{sentence}}' },
      {
        text: 'bank',
        sentence:
          'Sentence one is here. The bank of the river was muddy. Sentence three follows.'
      }
    )

    const messages = calls[0].body.messages
    const userMsg = messages[messages.length - 1].content
    expect(userMsg).toContain('The bank of the river was muddy.')
    expect(userMsg).not.toContain('Sentence three follows')
  })

  it('retries with the renamed token param when the provider rejects it', async () => {
    const calls = mockFetch((call, n) => {
      if (n === 1) {
        // first attempt: legacy model sends max_tokens, provider rejects it
        return {
          status: 400,
          json: {
            error: {
              message: "Unsupported parameter: 'max_tokens'",
              param: 'max_tokens',
              code: 'unsupported_parameter'
            }
          }
        }
      }
      return chatReply('ok')
    })

    const translated = await translate(
      { apiKey: 'sk-xxx', model: 'gpt-4o-mini', maxTokens: '128' },
      { text: 'bank' }
    )

    expect(calls[0].body.max_tokens).toBe(128)
    // retry: swapped to max_completion_tokens
    expect(calls[1].body.max_completion_tokens).toBe(128)
    expect(calls[1].body.max_tokens).toBeUndefined()
    expect(translated).toBe('ok')
    expect(calls.length).toBe(2)
  })

  it('requires an API key before calling the model', async () => {
    const config = getDefaultConfig()
    const profile = getDefaultProfile()

    const result = await search('hello', config, profile, { isPDF: false })

    expect(result.result.requireCredential).toBe(true)
    expect(result.result.id).toBe('openai')
  })

  it('returns a streaming marker from search when credentials are present', async () => {
    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config.dictAuth as any).openai.apiKey = 'sk-xxx'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.streaming).toBe(true)
    expect(result.result.args && result.result.args.text).toBeTruthy()
  })

  it('checks the key of the provider the model routes to', async () => {
    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    const auth = (config.dictAuth as any).openai
    auth.apiKey = 'sk-openai'
    auth.model = 'claude-haiku-5-5'

    const missing = await search('hello', config, profile, { isPDF: false })
    expect(missing.result.requireCredential).toBe(true)

    auth.anthropicApiKey = 'sk-ant'
    const ok = await search('hello', config, profile, { isPDF: false })
    expect(ok.result.streaming).toBe(true)
  })

  it('streams and accumulates SSE deltas', async () => {
    mockFetch(() => ({
      sse: [
        'data: {"choices":[{"delta":{"content":"<p>你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好</p>"}}]}\n\n',
        'data: [DONE]\n\n'
      ]
    }))

    const deltas: string[] = []
    await llmStream(
      { apiKey: 'sk-xxx' },
      { text: 'hello', from: 'en', to: 'zh-CN' },
      h => deltas.push(h)
    )

    expect(deltas[deltas.length - 1]).toBe('<p>你好</p>')
  })

  it('throws a status-carrying error when the stream returns 401', async () => {
    mockFetch(() => ({
      status: 401,
      json: { error: { message: 'invalid key' } }
    }))

    let caught: any
    try {
      await llmStream(
        { apiKey: 'bad' },
        { text: 'hi', from: 'en', to: 'zh-CN' },
        () => undefined
      )
    } catch (e) {
      caught = e
    }

    expect(caught && caught.status).toBe(401)
    expect(caught && caught.message).toBe('invalid key')
  })

  it('strips streaming code fences', () => {
    expect(stripStreamingFences('```html\n<p>hi</p>')).toBe('<p>hi</p>')
    expect(stripStreamingFences('<p>hi</p>\n```')).toBe('<p>hi</p>')
  })

  it('remaps reasoning_effort minimal -> none when rejected', async () => {
    const calls = mockFetch((call, n) =>
      n === 1
        ? {
            status: 400,
            json: {
              error: {
                message: "Unsupported value: 'reasoning_effort' minimal",
                param: 'reasoning_effort',
                code: 'unsupported_value'
              }
            }
          }
        : chatReply('ok')
    )

    const translated = await translate(
      { apiKey: 'sk-xxx', reasoningEffort: 'minimal' },
      { text: 'bank' }
    )

    expect(calls[0].body.reasoning_effort).toBe('minimal')
    expect(calls[1].body.reasoning_effort).toBe('none')
    expect(translated).toBe('ok')
    expect(calls.length).toBe(2)
  })

  it('always uses the configured systemPrompt/prompt (no hardcoded modes)', async () => {
    const calls = mockFetch(() => chatReply('<p>x</p>'))

    // a Chinese selection must still go through the user's configured prompt
    await translate(
      {
        apiKey: 'sk-xxx',
        systemPrompt: 'MY CUSTOM SYSTEM',
        prompt: 'translate {{text}}'
      },
      { text: '苹果', from: 'zh-CN', to: 'en' }
    )

    expect(calls[0].body.messages[0].content).toBe('MY CUSTOM SYSTEM')
    expect(calls[0].body.messages[1].content).toContain('苹果')
  })

  it('strips code fences from the model output', () => {
    expect(stripCodeFences('```html\n<p>hi</p>\n```')).toBe('<p>hi</p>')
    expect(stripCodeFences('<p>hi</p>')).toBe('<p>hi</p>')
  })
})

describe('provider routing', () => {
  it('infers the provider from the model name', () => {
    expect(inferProvider('gpt-5.4-nano')).toBe('openai')
    expect(inferProvider('o3-mini')).toBe('openai')
    expect(inferProvider('openai/gpt-5.4-nano')).toBe('openrouter')
    expect(inferProvider('anthropic/claude-haiku-4.5')).toBe('openrouter')
    expect(inferProvider('claude-haiku-5-5')).toBe('anthropic')
    expect(inferProvider('gemini-2.5-flash')).toBe('gemini')
    expect(inferProvider('deepseek-chat')).toBe('deepseek')
  })

  it("resolves the routed provider's own key and URL", () => {
    const keys = {
      apiKey: 'k-openai',
      openrouterApiKey: 'k-or',
      anthropicApiKey: 'k-ant',
      geminiApiKey: 'k-gem',
      deepseekApiKey: 'k-ds',
      baseUrl: 'https://ignored.example.com/v1'
    }
    const or = resolveLLMConfig({ ...keys, model: 'openai/gpt-5.4-nano' })
    expect(or.apiKey).toBe('k-or')
    expect(or.baseUrl).toBe('https://openrouter.ai/api/v1')

    const ant = resolveLLMConfig({ ...keys, model: 'claude-haiku-5-5' })
    expect(ant.protocol).toBe('anthropic')
    expect(ant.apiKey).toBe('k-ant')

    // baseUrl only applies to custom / ollama
    const oa = resolveLLMConfig({ ...keys, model: 'gpt-5.4-nano' })
    expect(oa.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('lets an explicit provider override the inference', () => {
    const ollama = resolveLLMConfig({ provider: 'ollama', model: 'qwen3:8b' })
    expect(ollama.baseUrl).toBe('http://localhost:11434/v1')
    expect(ollama.keyRequired).toBe(false)
    expect(ollama.apiKey).toBe('')

    const custom = resolveLLMConfig({
      provider: 'custom',
      model: 'claude-haiku-5-5',
      baseUrl: 'https://proxy.example.com/v1',
      customApiKey: 'k-custom'
    })
    expect(custom.protocol).toBe('openai-chat')
    expect(custom.baseUrl).toBe('https://proxy.example.com/v1')
    expect(custom.apiKey).toBe('k-custom')

    // unknown values fall back to inference
    expect(
      resolveLLMConfig({ provider: 'auto', model: 'deepseek-chat' }).provider
    ).toBe('deepseek')
    expect(
      resolveLLMConfig({ provider: 'toString', model: 'claude-haiku-5-5' })
        .provider
    ).toBe('anthropic')
  })

  it('sends OpenRouter its own reasoning and token params', async () => {
    const calls = mockFetch(() => chatReply('ok'))

    await translate(
      {
        openrouterApiKey: 'k-or',
        model: 'openai/gpt-5.4-nano',
        reasoningEffort: 'none',
        maxTokens: '300'
      },
      { text: 'bank' }
    )

    const { url, body, headers } = calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headers.Authorization).toBe('Bearer k-or')
    expect(body.reasoning).toEqual({ effort: 'none' })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.max_tokens).toBe(300)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })

  it('heals an OpenRouter 400 that only names the param in its message', async () => {
    const calls = mockFetch((call, n) =>
      n === 1
        ? {
            status: 400,
            json: {
              error: {
                code: 400,
                message: 'Reasoning is mandatory for this endpoint'
              }
            }
          }
        : chatReply('ok')
    )

    const translated = await translate(
      {
        openrouterApiKey: 'k-or',
        model: 'x-ai/grok-4',
        reasoningEffort: 'none'
      },
      { text: 'bank' }
    )

    expect(calls[1].body.reasoning).toBeUndefined()
    expect(translated).toBe('ok')
  })

  it('never sends reasoning_effort to DeepSeek', async () => {
    const calls = mockFetch(() => chatReply('ok'))

    await translate(
      {
        deepseekApiKey: 'k-ds',
        model: 'deepseek-chat',
        reasoningEffort: 'none'
      },
      { text: 'bank' }
    )

    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(calls[0].body.reasoning_effort).toBeUndefined()
  })

  it("reads Gemini's array-wrapped error message", async () => {
    mockFetch(() => ({
      status: 403,
      json: [
        {
          error: {
            code: 403,
            message: 'API key not valid',
            status: 'PERMISSION_DENIED'
          }
        }
      ]
    }))

    await expect(
      translate(
        { geminiApiKey: 'bad', model: 'gemini-2.5-flash' },
        { text: 'bank' }
      )
    ).rejects.toThrow('API key not valid')
  })
})

describe('anthropic adapter', () => {
  it('classifies Claude models that still take temperature', () => {
    expect(isLegacyClaudeModel('claude-haiku-4-5')).toBe(true)
    expect(isLegacyClaudeModel('claude-sonnet-4-20250514')).toBe(true)
    expect(isLegacyClaudeModel('claude-opus-4-6')).toBe(true)
    expect(isLegacyClaudeModel('claude-3-5-haiku-latest')).toBe(true)
    expect(isLegacyClaudeModel('claude-opus-4-7')).toBe(false)
    expect(isLegacyClaudeModel('claude-haiku-5-5')).toBe(false)
    expect(isLegacyClaudeModel('claude-sonnet-5-5')).toBe(false)
  })

  it('builds a Messages API request for current models', async () => {
    const calls = mockFetch(() => ({
      json: {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '银行' }
        ]
      }
    }))

    const translated = await translate(
      {
        anthropicApiKey: 'k-ant',
        model: 'claude-haiku-5-5',
        systemPrompt: 'SYS',
        prompt: '{{text}}',
        reasoningEffort: 'none'
      },
      { text: 'bank' }
    )

    const { url, body, headers } = calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(headers['x-api-key']).toBe('k-ant')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers.Authorization).toBeUndefined()
    // system prompt + IPA directive (single English word) as system blocks
    expect(body.system).toEqual([
      { type: 'text', text: 'SYS' },
      { type: 'text', text: IPA_DIRECTIVE }
    ])
    expect(body.messages).toEqual([{ role: 'user', content: 'bank' }])
    // required, defaulted when the user set no cap
    expect(body.max_tokens).toBe(4096)
    expect(body.temperature).toBeUndefined()
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(translated).toBe('银行')
  })

  it('sends temperature and no effort to pre-4.7 models', async () => {
    const calls = mockFetch(() => ({
      json: { content: [{ type: 'text', text: 'ok' }] }
    }))

    await translate(
      {
        anthropicApiKey: 'k-ant',
        model: 'claude-haiku-4-5',
        reasoningEffort: 'none',
        maxTokens: '600'
      },
      { text: 'bank' }
    )

    expect(calls[0].body.temperature).toBe(0)
    expect(calls[0].body.output_config).toBeUndefined()
    expect(calls[0].body.max_tokens).toBe(600)
  })

  it('streams text deltas and skips thinking deltas', async () => {
    mockFetch(() => ({
      sse: [
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"<p>银"}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"行</p>"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]
    }))

    const deltas: string[] = []
    await llmStream(
      { anthropicApiKey: 'k-ant', model: 'claude-haiku-5-5' },
      { text: 'bank', from: 'en', to: 'zh-CN' },
      h => deltas.push(h)
    )

    expect(deltas[deltas.length - 1]).toBe('<p>银行</p>')
  })

  it('throws on a mid-stream error event', async () => {
    mockFetch(() => ({
      sse: [
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
      ]
    }))

    await expect(
      llmStream(
        { anthropicApiKey: 'k-ant', model: 'claude-haiku-5-5' },
        { text: 'bank', from: 'en', to: 'zh-CN' },
        () => undefined
      )
    ).rejects.toThrow('Overloaded')
  })

  it('drops temperature when a model rejects it', async () => {
    const calls = mockFetch((call, n) =>
      n === 1
        ? {
            status: 400,
            json: {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'temperature is not supported for this model'
              }
            }
          }
        : { json: { content: [{ type: 'text', text: 'ok' }] } }
    )

    await translate(
      { anthropicApiKey: 'k-ant', model: 'claude-sonnet-4-6' },
      { text: 'bank' }
    )

    expect(calls[0].body.temperature).toBe(0)
    expect(calls[1].body.temperature).toBeUndefined()
  })
})

describe('heal cache', () => {
  const mandatoryReasoning: MockReply = {
    status: 400,
    json: {
      error: {
        code: 400,
        message:
          'Reasoning is mandatory for this endpoint and cannot be disabled.'
      }
    }
  }
  const geminiViaOpenRouter = {
    openrouterApiKey: 'k-or',
    model: 'google/gemini-3.5-flash-lite',
    reasoningEffort: 'none'
  }

  it('records a rename as drop + set and replays it', () => {
    const before = { model: 'm', messages: [], stream: true, max_tokens: 10 }
    const after = {
      model: 'm',
      messages: [],
      stream: true,
      max_completion_tokens: 10
    }
    const patch = diffBody(before, after)
    expect(patch).toEqual({
      drop: ['max_tokens'],
      set: { max_completion_tokens: 10 }
    })

    const body: Record<string, any> = { ...before, stream: false }
    applyPatch(body, patch!)
    expect(body).toEqual({ ...after, stream: false })
    expect(diffBody(before, { ...before, stream: false })).toBeNull()
  })

  it('sends the healed request straight away on the next lookup', async () => {
    const calls = mockFetch((call, n) =>
      n === 1 ? mandatoryReasoning : chatReply('ok')
    )

    await translate(geminiViaOpenRouter, { text: 'bank' })
    await settle()
    expect(calls.length).toBe(2)

    // the streaming path reuses the patch learned by the one-shot call
    mockFetch(() => ({
      sse: [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n'
      ]
    }))
    const streamCalls = (global as any).fetch.mock.calls
    await llmStream(
      geminiViaOpenRouter,
      { text: 'bank', from: 'en', to: 'zh-CN' },
      () => undefined
    )

    expect(streamCalls.length).toBe(1)
    expect(JSON.parse(streamCalls[0][1].body).reasoning).toBeUndefined()
  })

  it('re-learns when a setting that shapes the request changes', async () => {
    mockFetch((call, n) => (n === 1 ? mandatoryReasoning : chatReply('ok')))
    await translate(geminiViaOpenRouter, { text: 'bank' })
    await settle()

    const calls = mockFetch(() => chatReply('ok'))
    await translate(
      { ...geminiViaOpenRouter, reasoningEffort: 'minimal' },
      { text: 'bank' }
    )

    expect(calls[0].body.reasoning).toEqual({ effort: 'minimal' })
  })

  it('forgets a remembered patch that the provider now rejects', async () => {
    const auth = { anthropicApiKey: 'k-ant', model: 'claude-haiku-5-5' }
    const key = healKey(resolveLLMConfig(auth))
    // a stale patch that injects a param this model refuses
    storageData[HEAL_CACHE_KEY] = { [key]: { drop: [], set: { top_k: 5 } } }

    const calls = mockFetch((call, n) =>
      n === 1
        ? {
            status: 400,
            json: {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'top_k: unsupported'
              }
            }
          }
        : { json: { content: [{ type: 'text', text: 'ok' }] } }
    )

    const translated = await translate(auth, { text: 'bank' })
    await settle()

    expect(calls[0].body.top_k).toBe(5)
    expect(calls[1].body.top_k).toBeUndefined()
    expect(translated).toBe('ok')
    expect(storageData[HEAL_CACHE_KEY][key]).toBeUndefined()
  })
})
