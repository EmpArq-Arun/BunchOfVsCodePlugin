# Codex Intelligence — LLM Provider Configuration

All LLM backends are now controlled through one merged settings group
instead of a separate set of fields per provider. Switch providers via
**`Codex: Switch LLM provider`** (Command Palette) or by editing settings
directly.

## Settings

| Setting | Applies to | Description |
|---|---|---|
| `codex.llmProvider` | all | Which provider preset is active. One of the built-ins below, or a `codex.customProviders` entry's `id`. |
| `codex.llmApiKey` | providers that need a key | If blank, falls back to the provider's standard env var (see table), then to the generic `CODEX_API_KEY`. |
| `codex.llmBaseUrl` | overrides the preset default | Required for `azure-openai` and `custom`. Also useful for a remote LM Studio/Ollama/vLLM box. |
| `codex.llmModel` | overrides the preset default | Leave blank for `lmstudio`/`ollama` to use whatever model is currently loaded on the server. |
| `codex.llmDeployment` | `azure-openai` only | Your Azure deployment name. |
| `codex.llmApiVersion` | `azure-openai` only | Defaults to `2024-06-01`. |
| `codex.customProviders` | adds new options | Array of `{ id, displayName, baseUrl, model, requiresKey, envVar }` — see below. |

## Built-in providers

| `codex.llmProvider` value | Adapter | Default base URL | Needs a key? | Env var fallback |
|---|---|---|---|---|
| `lmstudio` | openai | `http://localhost:1234` | No | — |
| `ollama` | openai | `http://localhost:11434` | No | — |
| `vllm` | openai | `http://localhost:8000` | No | — |
| `openrouter` | openai | `https://openrouter.ai/api` | Yes | `OPENROUTER_API_KEY` |
| `openai` | openai | `https://api.openai.com` | Yes | `OPENAI_API_KEY` |
| `groq` | openai | `https://api.groq.com/openai` | Yes | `GROQ_API_KEY` |
| `together` | openai | `https://api.together.xyz` | Yes | `TOGETHER_API_KEY` |
| `mistral` | openai | `https://api.mistral.ai` | Yes | `MISTRAL_API_KEY` |
| `deepseek` | openai | `https://api.deepseek.com` | Yes | `DEEPSEEK_API_KEY` |
| `anthropic` | anthropic | `https://api.anthropic.com` | Yes | `ANTHROPIC_API_KEY` |
| `google-gemini` | gemini | `https://generativelanguage.googleapis.com` | Yes | `GEMINI_API_KEY` |
| `azure-openai` | openai | *(none — set `codex.llmBaseUrl`)* | Yes | `AZURE_OPENAI_API_KEY` |
| `custom` | openai | *(none — set `codex.llmBaseUrl`)* | No (set `requiresKey` via key/env if needed) | `CUSTOM_LLM_API_KEY` |

The full source of truth is `src/agent/providers/registry.ts` — adding a
provider that speaks the OpenAI `/v1/chat/completions` format is a single
data entry there (or use `codex.customProviders`, no code change needed
at all).

## Adding your own provider — no extension update required

Most LLM-serving products and services — including ones not yet released —
implement the OpenAI-compatible `/v1/chat/completions` shape, since it has
become the de facto standard. For any of those, add an entry to
`codex.customProviders` and it appears in the `Codex: Switch LLM provider`
picker immediately:

```json
"codex.customProviders": [
  {
    "id": "my-team-gateway",
    "displayName": "Team Inference Gateway",
    "baseUrl": "https://llm-gateway.internal.company.com",
    "model": "qwen2.5-coder-32b-instruct",
    "requiresKey": true,
    "envVar": "TEAM_GATEWAY_API_KEY"
  }
]
```

This covers self-hosted gateways, internal proxies, newer cloud providers,
and anything else exposing an OpenAI-compatible endpoint — without waiting
for a Codex Intelligence release.

If a provider uses a genuinely different wire format (not OpenAI,
Anthropic, or Gemini shaped), that needs a new adapter file under
`src/agent/providers/` implementing the `ProviderAdapter` interface, plus
a registry entry pointing `adapter` at it. See `TEST_PLAN.md` §1.4 for the
matching test-coverage requirement.

## Quick examples

**LM Studio with Qwen (default):**
```json
{ "codex.llmProvider": "lmstudio" }
```

**OpenRouter:**
```json
{
  "codex.llmProvider": "openrouter",
  "codex.llmApiKey": "sk-or-v1-..."
}
```
or just set `OPENROUTER_API_KEY` in your environment and leave `codex.llmApiKey` blank.

**Azure OpenAI:**
```json
{
  "codex.llmProvider": "azure-openai",
  "codex.llmBaseUrl": "https://my-resource.openai.azure.com",
  "codex.llmDeployment": "gpt4o-deployment",
  "codex.llmApiKey": "..."
}
```

**Google Gemini:**
```json
{
  "codex.llmProvider": "google-gemini",
  "codex.llmApiKey": "..."
}
```
