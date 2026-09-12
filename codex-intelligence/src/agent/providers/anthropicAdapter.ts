/**
 * providers/anthropicAdapter.ts
 *
 * Adapter for Anthropic's native Messages API (api.anthropic.com/v1/messages).
 * Different wire format from OpenAI: system prompt is a top-level field
 * (not a message), auth uses x-api-key + anthropic-version headers, and
 * the response shape is { content: [{ type: 'text', text }] } rather than
 * { choices: [{ message: { content } }] }.
 */

import { ProviderAdapter, ResolvedProviderConfig, CompleteParams } from './types';

interface AnthropicContentBlock { type: string; text?: string; }
interface AnthropicResponse {
  content: AnthropicContentBlock[];
  error?:  { type: string; message: string };
}

const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicAdapter implements ProviderAdapter {
  async complete(cfg: ResolvedProviderConfig, params: CompleteParams): Promise<string> {
    if (!cfg.apiKey) {
      throw new Error('Codex: Anthropic provider requires an API key (codex.llmApiKey).');
    }

    const body: Record<string, unknown> = {
      model:      cfg.model || 'claude-sonnet-4-5',
      max_tokens: params.maxTokens ?? 1000,
      messages:   params.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
    };
    if (params.system) { body['system'] = params.system; }

    const base = cfg.baseUrl.replace(/\/$/, '');
    const url  = `${base}/v1/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         cfg.apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify(body)
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Codex: Network error reaching Anthropic API: ${msg}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Codex: Anthropic API returned HTTP ${response.status}: ${text}`);
    }

    const data = await response.json() as AnthropicResponse;
    if (data.error) { throw new Error(`Codex: Anthropic error — ${data.error.message}`); }

    const text = data.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? '';
    if (!text) { throw new Error('Codex: Anthropic returned an empty response.'); }
    return text;
  }
}
