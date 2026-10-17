import pako from 'pako'
import {
  getDefaultConfig,
  AppConfig,
  DARK_MODE_DARK,
  DARK_MODE_FOLLOW
} from '@/app-config'
import { mergeConfig } from '@/app-config/merge-config'
import { storage } from './browser-api'
import { diffValue, applyPatch } from './sparse-patch'

import { Observable, from, concat, fromEventPattern } from 'rxjs'
import { map } from 'rxjs/operators'

/**
 * Config and profiles live in `storage.sync`, so Chrome Sync carries them to
 * every machine signed in to the same Chrome profile (needs the same extension
 * ID there, and "Extensions" turned on in Chrome's sync settings).
 * `storage.sync` caps each item at 8KB (QUOTA_BYTES_PER_ITEM), which is why the
 * config is stored sparse + deflated + base64 (see `deflate`).
 * `settingsStore` is the one place that picks the area.
 */
export const settingsStore = storage.sync

/** Chrome's per-item cap in `storage.sync`: key + JSON value, in UTF-8 bytes. */
export const SYNC_QUOTA_BYTES_PER_ITEM = 8192

/** Set in `local` once this machine has moved its settings into `sync`. */
const MOVED_TO_SYNC_FLAG = '__saladict_config_in_sync__'
/** Set in `sync` by the first machine that seeds it. */
const SYNC_SEEDED_KEY = '__saladict_sync_seeded__'

/**
 * One-time move for builds 8.0.25–8.0.33, which kept settings in
 * `storage.local`. The first machine to upgrade copies its local settings up;
 * a machine that finds `sync` already seeded by another one adopts it instead.
 * Local copies are left in place as a backup.
 */
export async function migrateStorageToSync(): Promise<void> {
  const flag = await storage.local.get(MOVED_TO_SYNC_FLAG)
  if (flag[MOVED_TO_SYNC_FLAG]) {
    return
  }

  try {
    const seeded = await storage.sync.get(SYNC_SEEDED_KEY)
    const local = await storage.local.get(null)
    if (!seeded[SYNC_SEEDED_KEY] && local.baseconfig) {
      const profileIDList: Array<{ id: string }> = local.profileIDList || []
      const toCopy: { [key: string]: any } = {
        baseconfig: deflate(inflate(local.baseconfig)),
        [SYNC_SEEDED_KEY]: Date.now()
      }
      if (local.activeProfileID) {
        toCopy.activeProfileID = local.activeProfileID
      }
      if (profileIDList.length > 0) {
        toCopy.profileIDList = profileIDList
        profileIDList.forEach(({ id }) => {
          if (local[id]) {
            toCopy[id] = local[id]
          }
        })
      }

      // `sync` may still hold profiles from before 8.0.25; drop the stale ones.
      const { profileIDList: staleList = [] } = await storage.sync.get<{
        profileIDList: Array<{ id: string }>
      }>('profileIDList')
      const staleIDs = staleList
        .map(({ id }) => id)
        .filter(id => !(id in toCopy))
      if (staleIDs.length > 0) {
        await storage.sync.remove(staleIDs)
      }

      await storage.sync.set(toCopy)
    }
    await storage.local.set({ [MOVED_TO_SYNC_FLAG]: true })
  } catch (e) {
    // Leave the flag unset so the next boot retries.
    console.error('Saladict: failed to move settings into storage.sync', e)
  }
}

export interface StorageChanged<T> {
  newValue?: T
  oldValue?: T
}

export interface AppConfigChanged {
  newConfig: AppConfig
  oldConfig?: AppConfig
}

export const PDF_VIEWER_DARK_MODE_LOCAL_KEY = 'saladict-pdf-viewer-dark-mode'

/** Compressed full config data */
interface AppConfigCompressedV1 {
  /** version */
  v: 1
  /** data */
  d: string
}

/**
 * Compressed sparse config data: only the fields that differ from
 * `getDefaultConfig()`, so values left at their default cost no storage
 * (and keep following the default if it changes).
 */
interface AppConfigCompressedV2 {
  /** version */
  v: 2
  /** data, deflated binary string */
  d: string
}

/**
 * Same as v2 but base64. A deflated binary string roughly doubles once JSON
 * stores it (bytes >= 0x80 take 2 UTF-8 bytes, control chars become
 * `\u00XX`); base64 grows by only 4/3, which matters under the sync quota.
 */
interface AppConfigCompressedV3 {
  /** version */
  v: 3
  /** data, deflated then base64 */
  d: string
}

type AppConfigCompressed =
  | AppConfigCompressedV1
  | AppConfigCompressedV2
  | AppConfigCompressedV3

function createConfigPatch(config: AppConfig): Partial<AppConfig> {
  const patch = diffValue(config, getDefaultConfig()) || {}
  // Always keep `version`, or a patch saved before a default bump would
  // inflate as the new version and skip mergeConfig's migrations.
  patch.version = config.version
  return patch
}

function deflate(config: AppConfig): AppConfigCompressedV3 {
  return {
    v: 3,
    d: btoa(
      pako.deflate(JSON.stringify(createConfigPatch(config)), {
        to: 'string'
      })
    )
  }
}

function inflate(config: AppConfig | AppConfigCompressed): AppConfig
function inflate(config: undefined): undefined
function inflate(
  config?: AppConfig | AppConfigCompressed
): AppConfig | undefined
function inflate(
  config?: AppConfig | AppConfigCompressed
): AppConfig | undefined {
  if (config && config['v'] === 1) {
    return JSON.parse(
      pako.inflate((config as AppConfigCompressedV1).d, { to: 'string' })
    )
  }
  if (config && (config['v'] === 2 || config['v'] === 3)) {
    const { v, d } = config as AppConfigCompressedV2 | AppConfigCompressedV3
    const patch = JSON.parse(
      pako.inflate(v === 3 ? atob(d) : d, { to: 'string' })
    )
    return applyPatch(getDefaultConfig(), patch)
  }
  return config as AppConfig
}

export async function initConfig(): Promise<AppConfig> {
  let baseconfig = await getConfig()

  baseconfig =
    baseconfig && baseconfig.version
      ? mergeConfig(baseconfig)
      : getDefaultConfig()

  await updateConfig(baseconfig)
  return baseconfig
}

export async function resetConfig() {
  const baseconfig = getDefaultConfig()
  await updateConfig(baseconfig)
  return baseconfig
}

export async function getConfig(): Promise<AppConfig> {
  const { baseconfig } = await settingsStore.get<{
    baseconfig: AppConfig
  }>('baseconfig')
  return inflate(baseconfig || getDefaultConfig())
}

export function updateConfig(baseconfig: AppConfig): Promise<void> {
  if (process.env.DEBUG) {
    console.log(`Saved config`, baseconfig)
  }

  syncPdfViewerDarkMode(baseconfig.darkMode)

  const compressed = deflate(baseconfig)
  // base64 is ASCII, so string length is the byte count Chrome checks.
  const bytes = ('baseconfig' + JSON.stringify(compressed)).length
  if (bytes > SYNC_QUOTA_BYTES_PER_ITEM) {
    return Promise.reject(
      new Error(
        `Settings take ${bytes} bytes, over Chrome sync's ${SYNC_QUOTA_BYTES_PER_ITEM}-byte limit. Shorten the AI prompt.`
      )
    )
  }

  return settingsStore.set({ baseconfig: compressed })
}

/**
 * Listen to config changes
 */
export async function addConfigListener(
  cb: (changes: AppConfigChanged) => any
) {
  settingsStore.addListener(changes => {
    if (changes.baseconfig) {
      const { newValue, oldValue } = changes.baseconfig as StorageChanged<
        AppConfigCompressed
      >
      if (newValue) {
        cb({ newConfig: inflate(newValue), oldConfig: inflate(oldValue) })
      }
    }
  })
}

/**
 * Get config and create a stream listening to config change
 */
export function createConfigStream(): Observable<AppConfig> {
  return concat(
    from(getConfig()),
    fromEventPattern<[AppConfigChanged] | AppConfigChanged>(
      addConfigListener
    ).pipe(map(args => (Array.isArray(args) ? args[0] : args).newConfig))
  )
}

function syncPdfViewerDarkMode(darkMode: AppConfig['darkMode']) {
  try {
    if (
      typeof localStorage !== 'undefined' &&
      typeof location !== 'undefined' &&
      /^(chrome-extension|moz-extension|safari-web-extension):$/.test(
        location.protocol
      )
    ) {
      localStorage.setItem(
        PDF_VIEWER_DARK_MODE_LOCAL_KEY,
        darkMode === DARK_MODE_FOLLOW
          ? DARK_MODE_FOLLOW
          : darkMode === DARK_MODE_DARK
          ? '1'
          : '0'
      )
    }
  } catch (error) {
    // Ignore localStorage failures in non-extension or restricted contexts.
  }
}
