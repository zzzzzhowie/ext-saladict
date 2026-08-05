import { TextEncoder, TextDecoder } from 'util'
import AxiosMockAdapter from 'axios-mock-adapter'
import axios from 'axios'

// jsdom doesn't provide these globals; the streaming engine + tests need them.
;(global as any).TextEncoder = (global as any).TextEncoder || TextEncoder
;(global as any).TextDecoder = (global as any).TextDecoder || TextDecoder
import { getDefaultConfig } from '@/app-config'
import { getDefaultProfile } from '@/app-config/profiles'
import {
  buildChatCompletionsUrl,
  extractSentence,
  isNewOpenAIModel,
  openaiStream,
  openaiTranslate,
  resolveOpenAIConfig,
  search,
  stripCodeFences,
  stripStreamingFences
} from '@/components/dictionaries/openai/engine'
import { DEFAULT_OPENAI_MODEL } from '@/components/dictionaries/openai/auth'

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
    const resolved = resolveOpenAIConfig({ apiKey: 'sk-xxx' })
    expect(resolved.model).toBe(DEFAULT_OPENAI_MODEL)
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1')
    expect(resolved.temperature).toBe(0)
  })

  it('parses temperature strings', () => {
    expect(resolveOpenAIConfig({ temperature: '0.7' }).temperature).toBe(0.7)
    expect(
      resolveOpenAIConfig({ temperature: 'not-a-number' }).temperature
    ).toBe(0)
  })

  it('fills prompt placeholders and reads the response content', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      expect(body.model).toBe('gpt-5.4-nano')
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[1].content).toContain('Hello, world!')
      expect(body.messages[1].content).toContain('zh-CN')
      // omitted when unset
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.max_tokens).toBeUndefined()
      return [200, { choices: [{ message: { content: '你好，世界！' } }] }]
    })

    const translated = await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx' }),
      text: 'Hello, world!',
      from: 'en',
      to: 'zh-CN'
    })

    expect(translated).toBe('你好，世界！')
    mock.restore()
  })

  it('fills the {{sentence}} placeholder with the selection context', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      expect(body.messages[1].content).toContain(
        'The bank of the river was muddy.'
      )
      return [200, { choices: [{ message: { content: '河岸' } }] }]
    })

    const translated = await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx' }),
      text: 'bank',
      from: 'en',
      to: 'zh-CN',
      sentence: 'The bank of the river was muddy.'
    })

    expect(translated).toBe('河岸')
    mock.restore()
  })

  it('uses max_completion_tokens and omits temperature for new models', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      expect(body.reasoning_effort).toBe('minimal')
      // gpt-5.4-nano is a "new" model: renamed param, no temperature
      expect(body.max_completion_tokens).toBe(256)
      expect(body.max_tokens).toBeUndefined()
      expect(body.temperature).toBeUndefined()
      return [200, { choices: [{ message: { content: 'ok' } }] }]
    })

    await openaiTranslate({
      ...resolveOpenAIConfig({
        apiKey: 'sk-xxx',
        reasoningEffort: 'minimal',
        maxTokens: '256'
      }),
      text: 'bank',
      from: 'en',
      to: 'zh-CN'
    })

    mock.restore()
  })

  it('uses max_tokens and sends temperature for legacy models', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      expect(body.max_tokens).toBe(256)
      expect(body.max_completion_tokens).toBeUndefined()
      expect(body.temperature).toBe(0)
      return [200, { choices: [{ message: { content: 'ok' } }] }]
    })

    await openaiTranslate({
      ...resolveOpenAIConfig({
        apiKey: 'sk-xxx',
        model: 'gpt-4o-mini',
        maxTokens: '256'
      }),
      text: 'bank',
      from: 'en',
      to: 'zh-CN'
    })

    mock.restore()
  })

  it('classifies new vs legacy OpenAI models', () => {
    expect(isNewOpenAIModel('gpt-5.4-nano')).toBe(true)
    expect(isNewOpenAIModel('gpt-5.4-mini')).toBe(true)
    expect(isNewOpenAIModel('o3-mini')).toBe(true)
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
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      const userMsg = body.messages[body.messages.length - 1].content
      // the full selection must be present, uncut
      expect(userMsg).toContain(paragraph)
      return [200, { choices: [{ message: { content: 'ok' } }] }]
    })

    await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx' }),
      text: paragraph,
      from: 'en',
      to: 'zh-CN',
      sentence: paragraph
    })

    mock.restore()
  })

  it('only sends the current sentence to the model', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      const userMsg = body.messages[body.messages.length - 1].content
      expect(userMsg).toContain('The bank of the river was muddy.')
      expect(userMsg).not.toContain('Sentence three follows')
      return [200, { choices: [{ message: { content: 'ok' } }] }]
    })

    await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx' }),
      text: 'bank',
      from: 'en',
      to: 'zh-CN',
      sentence:
        'Sentence one is here. The bank of the river was muddy. Sentence three follows.'
    })

    mock.restore()
  })

  it('retries with the renamed token param when the provider rejects it', async () => {
    const mock = new AxiosMockAdapter(axios)
    let calls = 0
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      calls++
      const body = JSON.parse(config.data)
      if (calls === 1) {
        // first attempt: legacy model sends max_tokens, provider rejects it
        expect(body.max_tokens).toBe(128)
        return [
          400,
          {
            error: {
              message: "Unsupported parameter: 'max_tokens'",
              param: 'max_tokens',
              code: 'unsupported_parameter'
            }
          }
        ]
      }
      // retry: swapped to max_completion_tokens
      expect(body.max_completion_tokens).toBe(128)
      expect(body.max_tokens).toBeUndefined()
      return [200, { choices: [{ message: { content: 'ok' } }] }]
    })

    const translated = await openaiTranslate({
      ...resolveOpenAIConfig({
        apiKey: 'sk-xxx',
        model: 'gpt-4o-mini',
        maxTokens: '128'
      }),
      text: 'bank',
      from: 'en',
      to: 'zh-CN'
    })

    expect(translated).toBe('ok')
    expect(calls).toBe(2)
    mock.restore()
  })

  it('requires an API key before calling OpenAI', async () => {
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

  it('streams and accumulates SSE deltas', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<p>你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好</p>"}}]}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    let i = 0
    const origFetch = (global as any).fetch
    ;(global as any).fetch = jest.fn(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length
              ? { done: false, value: encoder.encode(chunks[i++]) }
              : { done: true, value: undefined }
        })
      }
    }))

    const deltas: string[] = []
    await openaiStream(
      { apiKey: 'sk-xxx' },
      { text: 'hello', from: 'en', to: 'zh-CN' },
      h => deltas.push(h)
    )

    expect(deltas[deltas.length - 1]).toBe('<p>你好</p>')
    ;(global as any).fetch = origFetch
  })

  it('throws a status-carrying error when the stream returns 401', async () => {
    const origFetch = (global as any).fetch
    ;(global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => JSON.stringify({ error: { message: 'invalid key' } })
    }))

    let caught: any
    try {
      await openaiStream(
        { apiKey: 'bad' },
        { text: 'hi', from: 'en', to: 'zh-CN' },
        () => undefined
      )
    } catch (e) {
      caught = e
    }

    expect(caught && caught.status).toBe(401)
    ;(global as any).fetch = origFetch
  })

  it('strips streaming code fences', () => {
    expect(stripStreamingFences('```html\n<p>hi</p>')).toBe('<p>hi</p>')
    expect(stripStreamingFences('<p>hi</p>\n```')).toBe('<p>hi</p>')
  })

  it('remaps reasoning_effort minimal -> none when rejected', async () => {
    const mock = new AxiosMockAdapter(axios)
    let calls = 0
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      calls++
      const body = JSON.parse(config.data)
      if (calls === 1) {
        expect(body.reasoning_effort).toBe('minimal')
        return [
          400,
          {
            error: {
              message: "Unsupported value: 'reasoning_effort' minimal",
              param: 'reasoning_effort',
              code: 'unsupported_value'
            }
          }
        ]
      }
      expect(body.reasoning_effort).toBe('none')
      return [200, { choices: [{ message: { content: 'ok' } }] }]
    })

    const translated = await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx', reasoningEffort: 'minimal' }),
      text: 'bank',
      from: 'en',
      to: 'zh-CN'
    })

    expect(translated).toBe('ok')
    expect(calls).toBe(2)
    mock.restore()
  })

  it('always uses the configured systemPrompt/prompt (no hardcoded modes)', async () => {
    const mock = new AxiosMockAdapter(axios)
    let captured: any
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      captured = JSON.parse(config.data)
      return [200, { choices: [{ message: { content: '<p>x</p>' } }] }]
    })

    // a Chinese selection must still go through the user's configured prompt
    await openaiTranslate({
      ...resolveOpenAIConfig({
        apiKey: 'sk-xxx',
        systemPrompt: 'MY CUSTOM SYSTEM',
        prompt: 'translate {{text}}'
      }),
      text: '苹果',
      from: 'zh-CN',
      to: 'en'
    })

    expect(captured.messages[0].content).toBe('MY CUSTOM SYSTEM')
    expect(captured.messages[1].content).toContain('苹果')
    mock.restore()
  })

  it('strips code fences from the model output', () => {
    expect(stripCodeFences('```html\n<p>hi</p>\n```')).toBe('<p>hi</p>')
    expect(stripCodeFences('<p>hi</p>')).toBe('<p>hi</p>')
  })
})
