/**
 * llmClient.ts
 *
 * The only file in the LLM stack that imports 'vscode'. Reads the merged
 * provider settings (codex.llmProvider, codex.llmApiKey, codex.llmBaseUrl,
 * codex.llmModel, plus Azure-specific and custom-provider settings),
 * resolves them into a ResolvedProviderConfig, and dispatches to the
 * correct wire-format adapter (openai / anthropic / gemini).
 *
 * The adapters themselves (providers/*.ts) have ZERO vscode dependency —
 * they are plain fetch() calls, directly unit-testable. See test/run-tests.cjs.
 */

import * as vscode from 'vscode';
import {
  PROVIDER_PRESETS, ProviderPreset, CustomProviderDef, toPreset
} from './providers/registry';
import { ResolvedProviderConfig, CompleteParams, ProviderAdapter } from './providers/types';
import { OpenAICompatibleAdapter } from './providers/openaiCompatible';
import { AnthropicAdapter } from './providers/anthropicAdapter';
import { GeminiAdapter } from './providers/geminiAdapter';

export { LLMMessage, CompleteParams } from './providers/types';
export { PROVIDER_PRESETS } from './providers/registry';

const ADAPTERS: Record<ResolvedProviderConfig['adapter'], ProviderAdapter> = {
  openai:    new OpenAICompatibleAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini:    new GeminiAdapter()
};

/** All selectable providers: built-ins plus any from codex.customProviders,
 *  with the generic "custom" manual-entry option always sorted last. */
export function getAllProviders(): ProviderPreset[] {
  const cfg    = vscode.workspace.getConfiguration('codex');
  const custom = cfg.get<CustomProviderDef[]>('customProviders', []) || [];
  const customPresets = custom.filter(c => c && c.id && c.baseUrl).map(toPreset);

  const generic = PROVIDER_PRESETS.find(p => p.id === 'custom')!;
  const rest    = PROVIDER_PRESETS.filter(p => p.id !== 'custom');
  return [...rest, ...customPresets, generic];
}

export function readProviderConfig(): ResolvedProviderConfig {
  const cfg        = vscode.workspace.getConfiguration('codex');
  const providerId = cfg.get<string>('llmProvider', 'lmstudio');
  const preset      = getAllProviders().find(p => p.id === providerId) ?? PROVIDER_PRESETS[0];

  const baseUrlOverride = cfg.get<string>('llmBaseUrl', '').trim();
  const baseUrl = (baseUrlOverride || preset.defaultBaseUrl).replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      `Codex: No base URL configured for "${preset.displayName}".\n` +
      `Set "codex.llmBaseUrl" in settings.` +
      (preset.notes ? `\n${preset.notes}` : '')
    );
  }

  const modelOverride = cfg.get<string>('llmModel', '').trim();
  const model = modelOverride || preset.defaultModel;

  let apiKey = cfg.get<string>('llmApiKey', '').trim();
  if (!apiKey && preset.envVar && process.env[preset.envVar]) {
    apiKey = process.env[preset.envVar]!;
  }
  if (!apiKey && process.env['CODEX_API_KEY']) {
    apiKey = process.env['CODEX_API_KEY']!;
  }

  if (preset.requiresKey && !apiKey) {
    throw new Error(
      `Codex: No API key for ${preset.displayName}.\n` +
      `Set "codex.llmApiKey" in settings` +
      (preset.envVar ? `, or the ${preset.envVar} environment variable` : '') +
      `.` + (preset.notes ? `\n${preset.notes}` : '')
    );
  }

  const deployment = cfg.get<string>('llmDeployment', '').trim();
  const apiVersion = cfg.get<string>('llmApiVersion', '2024-06-01').trim();
  if (preset.id === 'azure-openai' && !deployment) {
    throw new Error('Codex: "codex.llmDeployment" is required when codex.llmProvider is "azure-openai".');
  }

  const isLocal     = ['lmstudio', 'ollama'].includes(preset.id) && !model;
  const modelSuffix = model
    ? ` · ${model.includes('/') ? model.split('/').pop() : model}`
    : (isLocal ? ' · (loaded model)' : '');

  return {
    id:      preset.id,
    label:   `${preset.displayName}${modelSuffix}`,
    baseUrl, apiKey, model,
    adapter: preset.adapter,
    extra:   preset.id === 'azure-openai' ? { deployment, apiVersion } : undefined
  };
}

export class LLMClient {
  constructor(private cfg: ResolvedProviderConfig) {}

  complete(params: CompleteParams): Promise<string> {
    return ADAPTERS[this.cfg.adapter].complete(this.cfg, params);
  }

  getLabel():      string { return this.cfg.label; }
  getProviderId(): string { return this.cfg.id; }
  getAdapter():    string { return this.cfg.adapter; }
}

/** Re-created on each call so settings changes apply without a reload. */
export function createLLMClient(): LLMClient {
  return new LLMClient(readProviderConfig());
}

// Back-compat alias used by statusViewProvider
export const readLLMConfig = readProviderConfig;
