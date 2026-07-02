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
  isChineseText,
  isNewOpenAIModel,
  isWordOrPhrase,
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

  it('translates a whole selected paragraph in full (never truncates it)', async () => {
    const paragraph = ('This is a long paragraph. ' + 'word '.repeat(200)).trim()
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

  it('classifies word/phrase vs sentence/paragraph', () => {
    expect(isWordOrPhrase('bank')).toBe(true)
    expect(isWordOrPhrase('machine learning')).toBe(true)
    expect(isWordOrPhrase('kick the bucket')).toBe(true)
    // sentence-ending punctuation -> not a phrase
    expect(isWordOrPhrase('The bank of the river was muddy.')).toBe(false)
    // long run of words -> not a phrase
    expect(isWordOrPhrase('one two three four five six seven eight')).toBe(false)
  })

  it('uses the study-card prompt for a word (mode 1)', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      // the user's configured (card) system prompt is used
      expect(body.messages[0].content).toContain('study assistant')
      return [200, { choices: [{ message: { content: '<p>x</p>' } }] }]
    })

    await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx' }),
      text: 'bank',
      from: 'en',
      to: 'zh-CN',
      sentence: 'The bank of the river was muddy.'
    })

    mock.restore()
  })

  it('detects Chinese and classifies short CJK as a phrase', () => {
    expect(isChineseText('苹果')).toBe(true)
    expect(isChineseText('apple')).toBe(false)
    expect(isWordOrPhrase('苹果')).toBe(true)
    expect(isWordOrPhrase('人工智能')).toBe(true)
    // a long space-less CJK run is a sentence, not a term
    expect(isWordOrPhrase('我今天心情不太好还有点累')).toBe(false)
    // long single English word is still a word
    expect(isWordOrPhrase('internationalization')).toBe(true)
  })

  it('lists English equivalents for a Chinese word (mode 3)', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      // the Chinese->English system prompt, not the study card
      expect(body.messages[0].content).toContain('English word')
      expect(body.messages[0].content).not.toContain('study assistant')
      expect(body.messages[0].content).not.toContain('translation engine')
      return [200, { choices: [{ message: { content: '<p>apple</p>' } }] }]
    })

    await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx' }),
      text: '苹果',
      from: 'zh-CN',
      to: 'zh-CN'
    })

    mock.restore()
  })

  it('forces translate-only for a sentence/paragraph (mode 2)', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost('https://api.openai.com/v1/chat/completions').reply(config => {
      const body = JSON.parse(config.data)
      // translate-only system prompt, not the study card
      expect(body.messages[0].content).toContain('translation engine')
      expect(body.messages[0].content).not.toContain('study assistant')
      return [200, { choices: [{ message: { content: '<p>译文</p>' } }] }]
    })

    await openaiTranslate({
      ...resolveOpenAIConfig({ apiKey: 'sk-xxx' }),
      text: 'The bank of the river was muddy, and the boat drifted away slowly.',
      from: 'en',
      to: 'zh-CN'
    })

    mock.restore()
  })

  it('strips code fences from the model output', () => {
    expect(stripCodeFences('```html\n<p>hi</p>\n```')).toBe('<p>hi</p>')
    expect(stripCodeFences('<p>hi</p>')).toBe('<p>hi</p>')
  })
})
