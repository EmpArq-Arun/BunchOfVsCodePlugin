/**
 * providers/types.ts
 *
 * Shared types for the multi-provider LLM client.
 * Every provider (LM Studio, Ollama, OpenAI, Anthropic, Gemini, OpenRouter,
 * Groq, Together, Mistral, DeepSeek, Azure OpenAI, or a fully custom
 * OpenAI-compatible endpoint) implements the same ProviderAdapter interface,
 * so agentLoop.ts never needs to know which one is active.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteParams {
  system?:    string;
  messages:   LLMMessage[];
  maxTokens?: number;
}

export interface ResolvedProviderConfig {
  /** Stable preset id, e.g. "lmstudio", "anthropic", "custom" */
  id:        string;
  /** Human-readable label shown in the status sidebar, e.g. "LM Studio · qwen2.5-coder-7b" */
  label:     string;
  /** Base URL, no trailing slash, no /v1 suffix */
  baseUrl:   string;
  /** Empty string = no auth header sent */
  apiKey:    string;
  /** Empty string = omitted from request body (provider uses its default/loaded model) */
  model:     string;
  /** Which wire-format adapter to use */
  adapter:   'openai' | 'anthropic' | 'gemini';
  /** Extra adapter-specific fields (e.g. Azure api-version, Azure deployment id) */
  extra?:    Record<string, string>;
}

export interface ProviderAdapter {
  complete(cfg: ResolvedProviderConfig, params: CompleteParams): Promise<string>;
}
