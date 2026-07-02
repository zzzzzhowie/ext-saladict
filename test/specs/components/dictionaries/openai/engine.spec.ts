import AxiosMockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import { getDefaultConfig } from '@/app-config'
import { getDefaultProfile } from '@/app-config/profiles'
import {
  buildChatCompletionsUrl,
  extractSentence,
  isNewOpenAIModel,
  openaiTranslate,
  resolveOpenAIConfig,
  search,
  stripCodeFences
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

  it('reports invalid OpenAI credentials', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock
      .onPost('https://api.openai.com/v1/chat/completions')
      .reply(401, { error: { message: 'invalid api key' } })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config.dictAuth as any).openai.apiKey = 'bad'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.credentialError).toBe('invalid')
    mock.restore()
  })

  it('translates via search on success', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock
      .onPost('https://api.openai.com/v1/chat/completions')
      .reply(200, { choices: [{ message: { content: '<p>你好</p>' } }] })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config.dictAuth as any).openai.apiKey = 'sk-xxx'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.html).toContain('你好')
    mock.restore()
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

  it('strips code fences from the model output', () => {
    expect(stripCodeFences('```html\n<p>hi</p>\n```')).toBe('<p>hi</p>')
    expect(stripCodeFences('<p>hi</p>')).toBe('<p>hi</p>')
  })
})
