/**
 * providers/openaiCompatible.ts
 *
 * Adapter for any provider that speaks the OpenAI /v1/chat/completions
 * wire format. This covers the large majority of providers:
 *   LM Studio, Ollama, OpenAI, OpenRouter, Groq, Together AI, Mistral,
 *   DeepSeek, Azure OpenAI, and any fully custom OpenAI-compatible endpoint.
 *
 * Differences between these providers are entirely in ResolvedProviderConfig
 * (base URL, auth header style, whether "model" is required) — the wire
 * format itself is identical, so one adapter serves them all.
 */

import { ProviderAdapter, ResolvedProviderConfig, CompleteParams, LLMMessage } from './types';

interface OAChoice {
  message: { role: string; content: string | null };
  finish_reason: string;
}
interface OAResponse {
  choices: OAChoice[];
  error?:  { message: string; code?: number | string };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  async complete(cfg: ResolvedProviderConfig, params: CompleteParams): Promise<string> {
    const messages: LLMMessage[] = [];
    if (params.system) { messages.push({ role: 'system', content: params.system }); }
    messages.push(...params.messages);

    const body: Record<string, unknown> = {
      messages,
      max_tokens:  params.maxTokens ?? 1000,
      temperature: 0.2
    };
    // Omit model key entirely when blank — LM Studio / Ollama serve whatever is loaded
    if (cfg.model) { body['model'] = cfg.model; }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) { headers['Authorization'] = `Bearer ${cfg.apiKey}`; }
    if (cfg.id === 'openrouter') {
      headers['HTTP-Referer'] = 'vscode://codex-intelligence';
      headers['X-Title']      = 'Codex Intelligence';
    }
    // Azure OpenAI uses its own header instead of Bearer, plus a query-string api-version
    let url: string;
    if (cfg.id === 'azure-openai') {
      delete headers['Authorization'];
      if (cfg.apiKey) { headers['api-key'] = cfg.apiKey; }
      const deployment = cfg.extra?.['deployment'] ?? cfg.model;
      const apiVersion = cfg.extra?.['apiVersion'] ?? '2024-06-01';
      url = `${cfg.baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
      // Azure does not want "model" in the body — it's encoded in the URL path
      delete body['model'];
    } else {
      const base = cfg.baseUrl.endsWith('/v1') ? cfg.baseUrl : `${cfg.baseUrl}/v1`;
      url = `${base}/chat/completions`;
    }

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (cfg.id === 'lmstudio') {
        throw new Error(
          `Codex: Cannot reach LM Studio at ${cfg.baseUrl}.\n\n` +
          `Check that:\n` +
          `  1. LM Studio is open and a model is loaded (My Models)\n` +
          `  2. The local server is running (Developer tab → Start Server)\n` +
          `  3. The port matches codex.llmBaseUrl (default: 1234)\n\nNetwork error: ${msg}`
        );
      }
      if (cfg.id === 'ollama') {
        throw new Error(
          `Codex: Cannot reach Ollama at ${cfg.baseUrl}.\n` +
          `Check that "ollama serve" is running and the port matches codex.llmBaseUrl.\nNetwork error: ${msg}`
        );
      }
      throw new Error(`Codex: Network error reaching ${url}: ${msg}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Codex: ${cfg.label} API returned HTTP ${response.status}: ${text}`);
    }

    const data = await response.json() as OAResponse;
    if (data.error) { throw new Error(`Codex: ${cfg.label} error — ${data.error.message}`); }

    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) { throw new Error(`Codex: ${cfg.label} returned an empty response.`); }
    return content;
  }
}
