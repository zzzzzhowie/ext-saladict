import { PROVIDERS, providerFromBaseUrl } from './providers/presets'

export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-nano'
export const DEFAULT_OPENAI_TEMPERATURE = '0'

/**
 * The prompts ship EMPTY on purpose. All behaviour lives in the prompt, and the
 * canonical copy is the repo-root `PROMPT.md` — the user pastes it into
 * 词典账号 → AI 翻译 (systemPrompt / prompt). Carrying no built-in default means
 * the engine never ships a prompt that drifts out of sync with PROMPT.md, and
 * there is nothing to migrate on version bumps.
 */
export const DEFAULT_OPENAI_SYSTEM_PROMPT = ''
export const DEFAULT_OPENAI_PROMPT = ''

/**
 * Flat string fields only: `mergeConfig` merges `dictAuth.<dict>.<key>` as
 * strings, so a nested per-provider object would be reset on every load.
 */
export const auth = {
  /** 'auto' = pick the provider from the model name (see inferProvider) */
  provider: 'auto',
  model: DEFAULT_OPENAI_MODEL,
  /** OpenAI key */
  apiKey: '',
  openrouterApiKey: '',
  anthropicApiKey: '',
  geminiApiKey: '',
  deepseekApiKey: '',
  /** custom OpenAI-compatible endpoint; optional override for Ollama */
  baseUrl: '',
  customApiKey: '',
  systemPrompt: DEFAULT_OPENAI_SYSTEM_PROMPT,
  prompt: DEFAULT_OPENAI_PROMPT,
  temperature: DEFAULT_OPENAI_TEMPERATURE,
  /**
   * none | minimal | low | medium | high | xhigh. 'none' = cheapest/fastest.
   * Mapped per provider (Claude: none → effort low); unsupported values are
   * auto-dropped by the engine.
   */
  reasoningEffort: 'none',
  /** max output tokens. Empty = no limit. Caps the worst-case output cost. */
  maxTokens: '600'
}

export type LLMAuth = typeof auth

export const url = 'https://openrouter.ai/models'

/**
 * Previous default model values. Used by the config migration to upgrade users
 * who never customised the model (their stored value still equals an old
 * default) to the current default, without touching manual edits.
 */
export const LEGACY_OPENAI_MODELS: ReadonlyArray<string> = [
  'gpt-4o-mini',
  'gpt-5.4-mini'
]

/**
 * Before multi-provider support the dict stored a single OpenAI-compatible
 * account (`baseUrl` + `apiKey`). Point `provider` at whatever that baseUrl
 * served and move the key into that provider's field. Run once, on configs
 * stored before `provider` existed.
 */
export function migrateSingleProviderAuth(stored: LLMAuth): void {
  const baseUrl = (stored.baseUrl || '').trim()
  stored.baseUrl = ''
  if (!baseUrl) return

  const provider = providerFromBaseUrl(baseUrl)
  if (provider === 'auto') return // api.openai.com: apiKey already is the OpenAI key

  stored.provider = provider
  if (provider === 'custom' || provider === 'ollama') {
    stored.baseUrl = baseUrl
  }
  const keyField = PROVIDERS[provider].keyField as keyof LLMAuth
  if (keyField && !stored[keyField]) {
    stored[keyField] = stored.apiKey
  }
  stored.apiKey = ''
}
