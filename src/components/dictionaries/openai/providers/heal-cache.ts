import { storage } from '@/_helpers/browser-api'
import { ResolvedLLMConfig } from './types'

/**
 * Remembers how a 400 was healed so the next lookup sends the fixed request
 * straight away instead of paying the rejected round trip again (e.g.
 * OpenRouter's "Reasoning is mandatory" on every Gemini 3 lookup).
 *
 * Lives in storage.local because an MV3 service worker is killed after ~30s
 * idle. The `dict_` prefix makes onInstalled clear it on every update, so a
 * patch learned against an older adapter's request shape never outlives it.
 */
export const HEAL_CACHE_KEY = 'dict_openai_heal'

const MAX_ENTRIES = 50

/** Prompt and transport fields, never touched by a heal. */
const IGNORED_KEYS = ['messages', 'system', 'stream']

export interface BodyPatch {
  drop: string[]
  set: Record<string, any>
}

type HealCache = Record<string, BodyPatch>

/** Everything that shapes the non-prompt params; changing any re-learns. */
export function healKey(cfg: ResolvedLLMConfig): string {
  return [
    cfg.provider,
    cfg.baseUrl,
    cfg.model,
    cfg.temperature,
    cfg.reasoningEffort,
    cfg.maxTokens
  ].join('|')
}

export function diffBody(
  before: Record<string, any>,
  after: Record<string, any>
): BodyPatch | null {
  const patch: BodyPatch = { drop: [], set: {} }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  keys.forEach(key => {
    if (IGNORED_KEYS.includes(key)) return
    if (!(key in after)) {
      patch.drop.push(key)
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      patch.set[key] = after[key]
    }
  })
  return patch.drop.length > 0 || Object.keys(patch.set).length > 0
    ? patch
    : null
}

export function applyPatch(body: Record<string, any>, patch: BodyPatch): void {
  patch.drop.forEach(key => {
    delete body[key]
  })
  Object.assign(body, patch.set)
}

// Read storage on every call (no in-memory copy): the background and the
// options page both heal, and a stale copy in one would clobber the other.
async function readCache(): Promise<HealCache> {
  try {
    const stored = await storage.local.get<{ [HEAL_CACHE_KEY]: HealCache }>(
      HEAL_CACHE_KEY
    )
    return (stored && stored[HEAL_CACHE_KEY]) || {}
  } catch {
    return {}
  }
}

export async function getPatch(key: string): Promise<BodyPatch | undefined> {
  return (await readCache())[key]
}

/** Store (or, with null, forget) the patch for `key`. Never throws. */
export async function savePatch(
  key: string,
  patch: BodyPatch | null
): Promise<void> {
  const cache = await readCache()
  if (patch) {
    delete cache[key] // re-insert so it counts as the newest entry
    cache[key] = patch
  } else if (key in cache) {
    delete cache[key]
  } else {
    return
  }
  const keys = Object.keys(cache)
  keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).forEach(old => {
    delete cache[old]
  })
  try {
    await storage.local.set({ [HEAL_CACHE_KEY]: cache })
  } catch {
    /* best effort: the next lookup just heals again */
  }
}
