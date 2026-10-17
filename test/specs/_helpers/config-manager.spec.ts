import * as configManagerOrigin from '@/_helpers/config-manager'
import { getDefaultConfig, AppConfigMutable } from '@/app-config'
import pako from 'pako'
import { pick } from 'lodash'
import { browser } from '../../helper'

type Area = 'sync' | 'local'

let areas: { [area in Area]: { [key: string]: any } }
let configManager: typeof configManagerOrigin

function fakeArea(area: Area) {
  const api = browser.storage[area]
  api.get.callsFake(keys =>
    Promise.resolve(
      keys == null
        ? { ...areas[area] }
        : pick(areas[area], Array.isArray(keys) ? keys : [keys])
    )
  )
  api.set.callsFake(items => {
    Object.assign(areas[area], JSON.parse(JSON.stringify(items)))
    return Promise.resolve()
  })
  api.remove.callsFake(keys => {
    ;(Array.isArray(keys) ? keys : [keys]).forEach(k => delete areas[area][k])
    return Promise.resolve()
  })
}

function customConfig(systemPrompt = 'be terse'): AppConfigMutable {
  const config = getDefaultConfig() as AppConfigMutable
  config.dictAuth.openai.systemPrompt = systemPrompt
  config.active = !config.active
  return config
}

describe('Config Manager', () => {
  beforeEach(() => {
    browser.flush()
    areas = { sync: {}, local: {} }
    fakeArea('sync')
    fakeArea('local')
    jest.resetModules()
    configManager = require('@/_helpers/config-manager')
  })

  it('stores config in sync as sparse base64 and reads it back', async () => {
    const config = customConfig()
    await configManager.updateConfig(config)

    expect(areas.local.baseconfig).toBeUndefined()
    const stored = areas.sync.baseconfig
    expect(stored.v).toBe(3)
    expect(stored.d).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(JSON.parse(pako.inflate(atob(stored.d), { to: 'string' }))).toEqual({
      version: config.version,
      active: config.active,
      dictAuth: { openai: { systemPrompt: 'be terse' } }
    })
    expect(await configManager.getConfig()).toEqual(config)
  })

  it('still reads v1 and v2 data', async () => {
    const config = customConfig()
    areas.sync.baseconfig = {
      v: 1,
      d: pako.deflate(JSON.stringify(config), { to: 'string' })
    }
    expect(await configManager.getConfig()).toEqual(config)

    areas.sync.baseconfig = {
      v: 2,
      d: pako.deflate(
        JSON.stringify({ version: config.version, active: config.active }),
        { to: 'string' }
      )
    }
    expect((await configManager.getConfig()).active).toBe(config.active)
  })

  it('rejects a config over the sync per-item quota', async () => {
    // Random text barely compresses, so this lands well over 8KB.
    let prompt = ''
    while (prompt.length < 12000) {
      prompt += Math.random()
        .toString(36)
        .slice(2)
    }
    await expect(
      configManager.updateConfig(customConfig(prompt))
    ).rejects.toThrow(/8192-byte limit/)
    expect(areas.sync.baseconfig).toBeUndefined()
  })

  it('moves local settings into an unseeded sync once', async () => {
    const config = customConfig()
    areas.local = {
      baseconfig: {
        v: 1,
        d: pako.deflate(JSON.stringify(config), { to: 'string' })
      },
      activeProfileID: 'p1',
      profileIDList: [{ id: 'p1', name: 'a' }],
      p1: { v: 2, d: 'x' }
    }
    // pre-8.0.25 leftovers
    areas.sync = {
      baseconfig: { v: 1, d: 'stale' },
      profileIDList: [{ id: 'old', name: 'b' }],
      old: { v: 2, d: 'stale' },
      hasInstructionsShown: true
    }

    await configManager.migrateStorageToSync()

    expect(areas.sync.baseconfig.v).toBe(3)
    expect(await configManager.getConfig()).toEqual(config)
    expect(areas.sync.activeProfileID).toBe('p1')
    expect(areas.sync.profileIDList).toEqual([{ id: 'p1', name: 'a' }])
    expect(areas.sync.p1).toEqual({ v: 2, d: 'x' })
    expect(areas.sync.old).toBeUndefined()
    expect(areas.sync.hasInstructionsShown).toBe(true)
    expect(areas.sync.__saladict_sync_seeded__).toEqual(expect.any(Number))
    // local copy kept as a backup
    expect(areas.local.baseconfig.v).toBe(1)

    // second run is a no-op
    areas.sync.baseconfig = { v: 3, d: 'changed-elsewhere' }
    await configManager.migrateStorageToSync()
    expect(areas.sync.baseconfig.d).toBe('changed-elsewhere')
  })

  it('adopts sync when another machine already seeded it', async () => {
    const mine = customConfig('mine')
    const theirs = { v: 3, d: 'theirs' }
    areas.local = {
      baseconfig: {
        v: 1,
        d: pako.deflate(JSON.stringify(mine), { to: 'string' })
      }
    }
    areas.sync = { baseconfig: theirs, __saladict_sync_seeded__: 1 }

    await configManager.migrateStorageToSync()

    expect(areas.sync.baseconfig).toEqual(theirs)
    expect(areas.local.__saladict_config_in_sync__).toBe(true)
  })
})
