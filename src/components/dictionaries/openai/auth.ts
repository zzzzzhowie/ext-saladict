export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-nano'
export const DEFAULT_OPENAI_TEMPERATURE = '0'

/**
 * The prompts ship EMPTY on purpose. All behaviour lives in the prompt, and the
 * canonical copy is the repo-root `PROMPT.md` — the user pastes it into
 * 词典账号 → OpenAI (systemPrompt / prompt). Carrying no built-in default means
 * the engine never ships a prompt that drifts out of sync with PROMPT.md, and
 * there is nothing to migrate on version bumps.
 */
export const DEFAULT_OPENAI_SYSTEM_PROMPT = ''
export const DEFAULT_OPENAI_PROMPT = ''

export const auth = {
  baseUrl: DEFAULT_OPENAI_BASE_URL,
  apiKey: '',
  model: DEFAULT_OPENAI_MODEL,
  systemPrompt: DEFAULT_OPENAI_SYSTEM_PROMPT,
  prompt: DEFAULT_OPENAI_PROMPT,
  temperature: DEFAULT_OPENAI_TEMPERATURE,
  /**
   * none | low | medium | high | xhigh. 'none' = cheapest/fastest (no
   * reasoning tokens). Unsupported values are auto-dropped by the engine.
   */
  reasoningEffort: 'none',
  /** max output tokens. Empty = no limit. Caps the worst-case output cost. */
  maxTokens: '600'
}

export const url = 'https://platform.openai.com/docs/api-reference/chat'

/**
 * Previous default model values. Used by the config migration to upgrade users
 * who never customised the model (their stored value still equals an old
 * default) to the current default, without touching manual edits.
 */
export const LEGACY_OPENAI_MODELS: ReadonlyArray<string> = [
  'gpt-4o-mini',
  'gpt-5.4-mini'
]
