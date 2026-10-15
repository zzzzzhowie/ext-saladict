import { ProviderID, Protocol } from './types'

export interface ProviderPreset {
  id: ProviderID
  label: string
  protocol: Protocol
  baseUrl: string
  /** `dictAuth.openai` field that holds this provider's key; '' = no key */
  keyField: string
  keyRequired: boolean
  /** every key this provider issues starts with it (where that holds) */
  keyPrefix?: string
  /** where the dict title links to */
  homepage: string
}

export const PROVIDERS: { [id in ProviderID]: ProviderPreset } = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    keyField: 'apiKey',
    keyRequired: true,
    homepage: 'https://platform.openai.com'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyField: 'openrouterApiKey',
    keyRequired: true,
    keyPrefix: 'sk-or-',
    homepage: 'https://openrouter.ai/models'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyField: 'anthropicApiKey',
    keyRequired: true,
    keyPrefix: 'sk-ant-',
    homepage: 'https://platform.claude.com'
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    // Google's official OpenAI-compatible endpoint, so no native adapter.
    protocol: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyField: 'geminiApiKey',
    keyRequired: true,
    homepage: 'https://aistudio.google.com'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    keyField: 'deepseekApiKey',
    keyRequired: true,
    homepage: 'https://platform.deepseek.com'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:11434/v1',
    keyField: '',
    keyRequired: false,
    homepage: 'https://ollama.com/library'
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    protocol: 'openai-chat',
    baseUrl: '',
    keyField: 'customApiKey',
    keyRequired: false,
    homepage: ''
  }
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderID[]

export function isProviderID(value: unknown): value is ProviderID {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDERS, value)
  )
}

/**
 * Pick the provider from the model name alone (provider = 'auto'):
 * `vendor/model` is an OpenRouter id; otherwise the vendor's own prefix routes
 * straight to that vendor. Ollama and custom endpoints can't be told apart by
 * name, so those are only reachable by choosing the provider explicitly.
 */
export function inferProvider(model: string): ProviderID {
  const m = model.trim().toLowerCase()
  if (m.includes('/')) return 'openrouter'
  if (m.startsWith('claude-')) return 'anthropic'
  if (/^(gemini|gemma)-/.test(m)) return 'gemini'
  if (m.startsWith('deepseek-')) return 'deepseek'
  return 'openai'
}

/** Key formats distinctive enough to name their issuer. DeepSeek and legacy
 * OpenAI keys are a bare `sk-…`, so they can't be attributed. */
const KEY_ISSUERS: Array<[string, ProviderID]> = [
  ['sk-or-', 'openrouter'],
  ['sk-ant-', 'anthropic'],
  ['sk-proj-', 'openai'],
  ['sk-svcacct-', 'openai'],
  ['AIza', 'gemini']
]

export interface KeyMismatch {
  /** the provider that issued this key, when its format gives it away */
  issuer?: ProviderID
  /** the prefix the routed provider's keys start with */
  expectedPrefix?: string
}

/**
 * Whether `apiKey` can't be a key for `provider` — e.g. an OpenAI `sk-proj-`
 * key pasted into the OpenRouter field, which OpenRouter answers with a
 * misleading "Missing Authentication header". Custom endpoints accept
 * anything, so they're never flagged.
 */
export function checkKeyFormat(
  provider: ProviderID,
  apiKey: string
): KeyMismatch | null {
  const key = apiKey.trim()
  if (!key || provider === 'custom') return null
  const hit = KEY_ISSUERS.find(([prefix]) => key.startsWith(prefix))
  const issuer = hit && hit[1] !== provider ? hit[1] : undefined
  const { keyPrefix } = PROVIDERS[provider]
  const expectedPrefix =
    keyPrefix && !key.startsWith(keyPrefix) ? keyPrefix : undefined
  return issuer || expectedPrefix ? { issuer, expectedPrefix } : null
}

/** Provider a pre-multi-provider `baseUrl` pointed at (config migration). */
export function providerFromBaseUrl(baseUrl: string): ProviderID | 'auto' {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return 'custom'
  }
  switch (url.hostname) {
    case 'api.openai.com':
      return 'auto'
    case 'openrouter.ai':
      return 'openrouter'
    case 'api.anthropic.com':
      return 'anthropic'
    case 'generativelanguage.googleapis.com':
      return 'gemini'
    case 'api.deepseek.com':
      return 'deepseek'
  }
  return url.port === '11434' ? 'ollama' : 'custom'
}
