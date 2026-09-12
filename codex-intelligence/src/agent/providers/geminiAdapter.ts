/**
 * providers/geminiAdapter.ts
 *
 * Adapter for Google's Gemini API (generativelanguage.googleapis.com).
 * Different wire format again: the model is in the URL path, the API key
 * is a query parameter (not a header), "messages" are called "contents"
 * with "parts", and the system prompt is a separate "systemInstruction"
 * field rather than a message.
 */

import { ProviderAdapter, ResolvedProviderConfig, CompleteParams } from './types';

interface GeminiPart { text?: string; }
interface GeminiCandidate { content?: { parts?: GeminiPart[] }; finishReason?: string; }
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message: string; code?: number };
}

export class GeminiAdapter implements ProviderAdapter {
  async complete(cfg: ResolvedProviderConfig, params: CompleteParams): Promise<string> {
    if (!cfg.apiKey) {
      throw new Error('Codex: Gemini provider requires an API key (codex.llmApiKey).');
    }
    const model = cfg.model || 'gemini-2.0-flash-001';
    const base  = cfg.baseUrl.replace(/\/$/, '');
    const url   = `${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;

    // Gemini has no "assistant" role name — it uses "model" instead of "assistant"
    const contents = params.messages.map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: params.maxTokens ?? 1000,
        temperature:     0.2
      }
    };
    if (params.system) {
      body['systemInstruction'] = { parts: [{ text: params.system }] };
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Codex: Network error reaching Gemini API: ${msg}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Codex: Gemini API returned HTTP ${response.status}: ${text}`);
    }

    const data = await response.json() as GeminiResponse;
    if (data.error) { throw new Error(`Codex: Gemini error — ${data.error.message}`); }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text  = parts.map(p => p.text ?? '').join('');
    if (!text) { throw new Error('Codex: Gemini returned an empty response.'); }
    return text;
  }
}
