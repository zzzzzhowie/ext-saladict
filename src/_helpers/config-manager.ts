import pako from 'pako'
import {
  getDefaultConfig,
  AppConfig,
  DARK_MODE_DARK,
  DARK_MODE_FOLLOW
} from '@/app-config'
import { mergeConfig } from '@/app-config/merge-config'
import { storage } from './browser-api'

import { Observable, from, concat, fromEventPattern } from 'rxjs'
import { map } from 'rxjs/operators'

/**
 * Config now lives in `storage.local` instead of `storage.sync`.
 * `storage.sync` caps each item at 8KB (kQuotaBytesPerItem) and only syncs for
 * Web-Store installs, so a long OpenAI systemPrompt blew the quota. `local` has
 * ~10MB and no per-item cap. Cross-device settings sync is dropped in favour of
 * the built-in import/export. All reads/writes/listeners go through `store`.
 */
const store = storage.local

const STORAGE_MIGRATED_FLAG = '__saladict_config_in_local__'

/**
 * One-time migration for users upgrading from a `storage.sync`-based build:
 * copy any existing sync data into `local` so their settings/prompts survive.
 * Idempotent — guarded by a persistent flag; `local` always wins on conflict.
 */
export async function migrateStorageToLocal(): Promise<void> {
  const flag = await storage.local.get<{ [k: string]: boolean }>(
    STORAGE_MIGRATED_FLAG
  )
  if (flag[STORAGE_MIGRATED_FLAG]) {
    return
  }

  const synced = await storage.sync.get(null)
  if (synced && Object.keys(synced).length > 0) {
    const local = await storage.local.get(null)
    const toCopy: { [key: string]: any } = {}
    Object.keys(synced).forEach(key => {
      if (!(key in local)) {
        toCopy[key] = synced[key]
      }
    })
    if (Object.keys(toCopy).length > 0) {
      await storage.local.set(toCopy)
    }
  }

  await storage.local.set({ [STORAGE_MIGRATED_FLAG]: true })
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

/** Compressed config data */
interface AppConfigCompressed {
  /** version */
  v: 1
  /** data */
  d: string
}

function deflate(config: AppConfig): AppConfigCompressed {
  return {
    v: 1,
    d: pako.deflate(JSON.stringify(config), { to: 'string' })
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
      pako.inflate((config as AppConfigCompressed).d, { to: 'string' })
    )
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
  const { baseconfig } = await store.get<{
    baseconfig: AppConfig
  }>('baseconfig')
  return inflate(baseconfig || getDefaultConfig())
}

export function updateConfig(baseconfig: AppConfig): Promise<void> {
  if (process.env.DEBUG) {
    console.log(`Saved config`, baseconfig)
  }

  syncPdfViewerDarkMode(baseconfig.darkMode)

  return store.set({ baseconfig: deflate(baseconfig) })
}

/**
 * Listen to config changes
 */
export async function addConfigListener(
  cb: (changes: AppConfigChanged) => any
) {
  store.addListener(changes => {
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
