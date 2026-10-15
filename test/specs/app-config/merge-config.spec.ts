import { AppConfigMutable, getDefaultConfig } from '@/app-config'
import { mergeConfig } from '@/app-config/merge-config'
import { getDefaultProfile } from '@/app-config/profiles'
import { DEFAULT_OPENAI_MODEL } from '@/components/dictionaries/openai/auth'

describe('mergeConfig', () => {
  it('drops unsupported dictionary auth entries and keeps supported credentials', () => {
    const oldConfig = getDefaultConfig() as AppConfigMutable

    oldConfig.dictAuth.baidu.appid = 'appid'
    oldConfig.dictAuth.baidu.key = 'key'
    oldConfig.dictAuth.alibaba.accessKeyId = 'ak'
    oldConfig.dictAuth.alibaba.accessKeySecret = 'sk'
    oldConfig.dictAuth.volc.accessKeyId = 'volc-ak'
    oldConfig.dictAuth.volc.secretAccessKey = 'volc-sk'
    oldConfig.dictAuth.niutrans.apikey = 'niu-key'
    oldConfig.dictAuth.deepl.authKey = 'deepl-key'
    oldConfig.dictAuth.deeplx.apiUrl = 'https://deeplx.example.com'
    oldConfig.dictAuth.deeplx.token = 'deeplx-token'
    ;(oldConfig.dictAuth as any).sogou = {
      token: 'legacy'
    }

    const mergedConfig = mergeConfig(oldConfig)

    expect((mergedConfig.dictAuth as any).sogou).toBeUndefined()
    expect(mergedConfig.dictAuth.baidu).toEqual({
      appid: 'appid',
      key: 'key'
    })
    expect(mergedConfig.dictAuth.alibaba).toEqual({
      accessKeyId: 'ak',
      accessKeySecret: 'sk'
    })
    expect(mergedConfig.dictAuth.volc).toEqual({
      accessKeyId: 'volc-ak',
      secretAccessKey: 'volc-sk'
    })
    expect(mergedConfig.dictAuth.niutrans).toEqual({
      apikey: 'niu-key'
    })
    expect(mergedConfig.dictAuth.deepl).toEqual({
      authKey: 'deepl-key'
    })
    expect(mergedConfig.dictAuth.deeplx).toEqual({
      apiUrl: 'https://deeplx.example.com',
      token: 'deeplx-token'
    })
    expect(Object.keys(mergedConfig.dictAuth).sort()).toEqual([
      'alibaba',
      'baidu',
      'caiyun',
      'deepl',
      'deeplx',
      'niutrans',
      'openai',
      'tencent',
      'volc',
      'youdaotrans'
    ])
  })

  it('upgrades a legacy OpenAI model to the current default and leaves prompts untouched', () => {
    const oldConfig = getDefaultConfig() as AppConfigMutable
    oldConfig.dictAuth.openai.model = 'gpt-4o-mini'
    oldConfig.dictAuth.openai.systemPrompt = 'whatever the user had'
    oldConfig.dictAuth.openai.prompt = ''

    const merged = mergeConfig(oldConfig)

    expect(merged.dictAuth.openai.model).toBe(DEFAULT_OPENAI_MODEL)
    // prompts are never migrated: empty stays empty, custom stays custom
    expect(merged.dictAuth.openai.systemPrompt).toBe('whatever the user had')
    expect(merged.dictAuth.openai.prompt).toBe('')
  })

  it('never clobbers a user-configured OpenAI prompt', () => {
    const oldConfig = getDefaultConfig() as AppConfigMutable
    oldConfig.dictAuth.openai.systemPrompt = 'my custom system prompt'
    oldConfig.dictAuth.openai.prompt = 'my custom prompt'

    const merged = mergeConfig(oldConfig)

    expect(merged.dictAuth.openai.systemPrompt).toBe('my custom system prompt')
    expect(merged.dictAuth.openai.prompt).toBe('my custom prompt')
  })

  /** A stored AI account from before multi-provider support (no `provider`). */
  const singleProviderConfig = (baseUrl: string, apiKey: string) => {
    const oldConfig = getDefaultConfig() as AppConfigMutable
    const { provider, ...legacy } = oldConfig.dictAuth.openai as any
    ;(oldConfig.dictAuth as any).openai = { ...legacy, baseUrl, apiKey }
    return oldConfig
  }

  it('keeps an api.openai.com account as the OpenAI key', () => {
    const merged = mergeConfig(
      singleProviderConfig('https://api.openai.com/v1', 'sk-openai')
    )
    expect(merged.dictAuth.openai.provider).toBe('auto')
    expect(merged.dictAuth.openai.apiKey).toBe('sk-openai')
    expect(merged.dictAuth.openai.baseUrl).toBe('')
  })

  it('moves a single OpenRouter account to the OpenRouter key', () => {
    const merged = mergeConfig(
      singleProviderConfig('https://openrouter.ai/api/v1', 'sk-or')
    )
    expect(merged.dictAuth.openai.provider).toBe('openrouter')
    expect(merged.dictAuth.openai.openrouterApiKey).toBe('sk-or')
    expect(merged.dictAuth.openai.apiKey).toBe('')
    expect(merged.dictAuth.openai.baseUrl).toBe('')
  })

  it('keeps an unknown endpoint as a custom provider', () => {
    const merged = mergeConfig(
      singleProviderConfig('https://proxy.example.com/v1', 'sk-proxy')
    )
    expect(merged.dictAuth.openai.provider).toBe('custom')
    expect(merged.dictAuth.openai.baseUrl).toBe('https://proxy.example.com/v1')
    expect(merged.dictAuth.openai.customApiKey).toBe('sk-proxy')
    expect(merged.dictAuth.openai.apiKey).toBe('')
  })

  it('recognises a local Ollama endpoint', () => {
    const merged = mergeConfig(
      singleProviderConfig('http://127.0.0.1:11434/v1', '')
    )
    expect(merged.dictAuth.openai.provider).toBe('ollama')
    expect(merged.dictAuth.openai.baseUrl).toBe('http://127.0.0.1:11434/v1')
  })

  it('leaves an already multi-provider config alone', () => {
    const oldConfig = getDefaultConfig() as AppConfigMutable
    oldConfig.dictAuth.openai.provider = 'custom'
    oldConfig.dictAuth.openai.baseUrl = 'https://openrouter.ai/api/v1'
    oldConfig.dictAuth.openai.customApiKey = 'sk-custom'

    const merged = mergeConfig(oldConfig)

    expect(merged.dictAuth.openai.provider).toBe('custom')
    expect(merged.dictAuth.openai.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(merged.dictAuth.openai.customApiKey).toBe('sk-custom')
  })

  it('keeps new machine translators aligned with default language behavior', () => {
    const profile = getDefaultProfile()

    for (const id of [
      'alibaba',
      'volc',
      'niutrans',
      'deepl',
      'deeplx'
    ] as const) {
      expect(profile.dicts.all[id].options.slInitial).toBe('collapse')
      expect(profile.dicts.all[id].options.tl).toBe('default')
      expect(profile.dicts.all[id].options.tl2).toBe('default')
      expect(profile.dicts.all[id].options_sel.tl).toContain('default')
      expect(profile.dicts.all[id].options_sel.tl2).toContain('default')
    }
  })
})
