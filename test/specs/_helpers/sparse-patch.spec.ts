import { getDefaultConfig, AppConfigMutable } from '@/app-config'
import { diffValue, applyPatch } from '@/_helpers/sparse-patch'

describe('sparse-patch', () => {
  it('stores nothing for an untouched default config', () => {
    expect(diffValue(getDefaultConfig(), getDefaultConfig())).toBeUndefined()
  })

  it('keeps only changed leaves and round-trips', () => {
    const config = getDefaultConfig() as AppConfigMutable
    config.dictAuth.openai.systemPrompt = 'be terse'
    config.blacklist = [['^https://x\\.com', 'x']]
    config.active = !config.active

    const patch = diffValue(config, getDefaultConfig())
    expect(patch).toEqual({
      active: config.active,
      blacklist: config.blacklist,
      dictAuth: { openai: { systemPrompt: 'be terse' } }
    })
    expect(applyPatch(getDefaultConfig(), patch)).toEqual(config)
  })

  it('records removed default keys so they stay removed', () => {
    const config = getDefaultConfig() as AppConfigMutable
    const removed = Object.keys(config.contextMenus.all)[0]
    delete config.contextMenus.all[removed]

    const patch = diffValue(config, getDefaultConfig())
    expect(patch.contextMenus.all).toEqual({ $deleted: [removed] })
    expect(applyPatch(getDefaultConfig(), patch)).toEqual(config)
  })
})
