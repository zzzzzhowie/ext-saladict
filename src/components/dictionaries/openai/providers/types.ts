export type ProviderID =
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'ollama'
  | 'custom'

/** Wire protocol an adapter speaks. Every preset maps onto one of these. */
export type Protocol = 'openai-chat' | 'anthropic'

/** The prompt in a shape every protocol can express: system instructions plus
 * a single user turn (the dict never sends history). */
export interface ChatInput {
  system: string[]
  user: string
}

export interface ResolvedLLMConfig {
  provider: ProviderID
  protocol: Protocol
  baseUrl: string
  apiKey: string
  /** false for endpoints that run without a key (local Ollama, custom) */
  keyRequired: boolean
  model: string
  systemPrompt: string
  prompt: string
  temperature: number
  /** '' means don't send a reasoning/effort param */
  reasoningEffort: string
  /** 0 means no explicit output cap (Anthropic still gets its required default) */
  maxTokens: number
}

export interface LLMRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

export interface StreamEvent {
  text?: string
  done?: boolean
  error?: string
}

export interface LLMError {
  /** OpenAI names the rejected param; most other providers don't */
  param?: string
  message: string
}

export interface LLMAdapter {
  buildRequest(
    cfg: ResolvedLLMConfig,
    chat: ChatInput,
    stream: boolean
  ): LLMRequest
  /** One SSE `data:` payload, JSON-parsed (a bare `[DONE]` stays a string). */
  parseStreamEvent(data: any): StreamEvent
  parseResponse(json: any): string
  /** Mutate `body` to get past a 400 the provider returned; false = give up. */
  heal(body: Record<string, any>, error: LLMError): boolean
}
