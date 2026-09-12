/**
 * providers/registry.ts
 *
 * Single source of truth for every supported LLM backend.
 * Adding a new provider preset is a one-entry change here — no other
 * file needs to change unless the provider uses a wire format that
 * isn't already covered by the openai / anthropic / gemini adapters.
 */

export interface ProviderPreset {
  id:           string;
  displayName:  string;
  adapter:      'openai' | 'anthropic' | 'gemini';
  defaultBaseUrl: string;
  defaultModel:   string;     // '' = no default, provider requires explicit model or uses loaded model
  requiresKey:    boolean;
  envVar:         string;     // environment variable checked if codex.llmApiKey is blank
  notes:          string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'lmstudio', displayName: 'LM Studio (local)', adapter: 'openai',
    defaultBaseUrl: 'http://localhost:1234', defaultModel: '',
    requiresKey: false, envVar: '',
    notes: 'No API key needed. Leave model blank to use whatever is loaded in LM Studio.'
  },
  {
    id: 'ollama', displayName: 'Ollama (local)', adapter: 'openai',
    defaultBaseUrl: 'http://localhost:11434', defaultModel: 'qwen2.5-coder:7b',
    requiresKey: false, envVar: '',
    notes: 'Requires "ollama serve" running. Model must be pulled first: ollama pull qwen2.5-coder:7b'
  },
  {
    id: 'openai', displayName: 'OpenAI', adapter: 'openai',
    defaultBaseUrl: 'https://api.openai.com', defaultModel: 'gpt-4o',
    requiresKey: true, envVar: 'OPENAI_API_KEY',
    notes: 'Get a key at platform.openai.com/api-keys'
  },
  {
    id: 'anthropic', displayName: 'Anthropic (direct)', adapter: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5',
    requiresKey: true, envVar: 'ANTHROPIC_API_KEY',
    notes: 'Get a key at console.anthropic.com'
  },
  {
    id: 'google-gemini', displayName: 'Google Gemini', adapter: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-2.0-flash-001',
    requiresKey: true, envVar: 'GEMINI_API_KEY',
    notes: 'Get a key at aistudio.google.com/apikey'
  },
  {
    id: 'openrouter', displayName: 'OpenRouter', adapter: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api', defaultModel: 'anthropic/claude-sonnet-4-5',
    requiresKey: true, envVar: 'OPENROUTER_API_KEY',
    notes: 'Gateway to many models with one key. Get one at openrouter.ai/keys'
  },
  {
    id: 'groq', displayName: 'Groq', adapter: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai', defaultModel: 'llama-3.3-70b-versatile',
    requiresKey: true, envVar: 'GROQ_API_KEY',
    notes: 'Very fast inference. Get a key at console.groq.com/keys'
  },
  {
    id: 'together', displayName: 'Together AI', adapter: 'openai',
    defaultBaseUrl: 'https://api.together.xyz', defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    requiresKey: true, envVar: 'TOGETHER_API_KEY',
    notes: 'Get a key at api.together.ai/settings/api-keys'
  },
  {
    id: 'mistral', displayName: 'Mistral AI', adapter: 'openai',
    defaultBaseUrl: 'https://api.mistral.ai', defaultModel: 'codestral-latest',
    requiresKey: true, envVar: 'MISTRAL_API_KEY',
    notes: 'Get a key at console.mistral.ai/api-keys'
  },
  {
    id: 'deepseek', displayName: 'DeepSeek', adapter: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-coder',
    requiresKey: true, envVar: 'DEEPSEEK_API_KEY',
    notes: 'Get a key at platform.deepseek.com/api_keys'
  },
  {
    id: 'azure-openai', displayName: 'Azure OpenAI', adapter: 'openai',
    defaultBaseUrl: '', defaultModel: '',
    requiresKey: true, envVar: 'AZURE_OPENAI_API_KEY',
    notes: 'Set codex.llmBaseUrl to your resource endpoint and codex.llmDeployment to your deployment name.'
  },
  {
    id: 'custom', displayName: 'Custom (any OpenAI-compatible endpoint)', adapter: 'openai',
    defaultBaseUrl: '', defaultModel: '',
    requiresKey: false, envVar: 'CUSTOM_LLM_API_KEY',
    notes: 'Set codex.llmBaseUrl to your endpoint base URL. Works with vLLM, llama.cpp server, text-generation-webui, LocalAI, and anything else exposing /v1/chat/completions.'
  }
];

export function getPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find(p => p.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

export function presetIds(): string[] {
  return PROVIDER_PRESETS.map(p => p.id);
}

/** User-defined providers from the codex.customProviders setting.
 *  Always treated as 'openai' adapter — covers the large majority of
 *  niche/new services without needing a code change or extension update. */
export interface CustomProviderDef {
  id: string;
  displayName?: string;
  baseUrl: string;
  model?: string;
  requiresKey?: boolean;
  envVar?: string;
}

export function toPreset(c: CustomProviderDef): ProviderPreset {
  return {
    id: c.id,
    displayName: c.displayName || c.id,
    adapter: 'openai',
    defaultBaseUrl: c.baseUrl,
    defaultModel: c.model ?? '',
    requiresKey: c.requiresKey ?? !!c.envVar,
    envVar: c.envVar ?? '',
    notes: ''
  };
}
