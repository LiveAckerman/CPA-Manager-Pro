/**
 * Map a saved provider config -> ProviderTestModal props ("preset").
 * Used by the list page so the test button knows what to test for each row.
 */
import type {
  AmpcodeConfig,
  GeminiKeyConfig,
  ModelAlias,
  OpenAIProviderConfig,
  ProviderKeyConfig,
} from '@/types';

import type { ProviderTestModalProps } from './ProviderTestModal';
import type { ProviderKind } from './providerTest';

export type ProviderTestPreset = Omit<ProviderTestModalProps, 'open' | 'onClose'>;

/** Build a preset from an edit-page draft (single credential, in-form values). */
export interface DraftTestInput {
  label: string;
  baseUrl?: string;
  apiKey?: string;
  authIndex?: string;
  headers?: Record<string, string>;
  modelNames: string[];
  defaultModel?: string;
}

export function draftTestPreset(
  kind: ProviderKind,
  badge: string,
  input: DraftTestInput
): ProviderTestPreset {
  const models = input.modelNames.filter(Boolean);
  return {
    kind,
    badge,
    providerLabel: input.label,
    models,
    defaultModel: input.defaultModel || models[0],
    authOptions: [
      {
        label: input.label,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        authIndex: input.authIndex,
        headers: input.headers,
      },
    ],
  };
}

const maskKey = (key?: string): string => {
  const k = String(key ?? '').trim();
  if (!k) return '';
  if (k.length <= 8) return `••••${k.slice(-2)}`;
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
};

const modelNames = (models?: ModelAlias[]): string[] =>
  (models ?? []).map((m) => String(m?.name ?? '').trim()).filter(Boolean);

const labelFor = (cfg: { prefix?: string; baseUrl?: string }, fallback: string): string =>
  String(cfg.prefix || cfg.baseUrl || '').trim() || fallback;

/** Claude / Codex / Vertex all share ProviderKeyConfig. */
export function providerKeyTestPreset(
  kind: ProviderKind,
  badge: string,
  cfg: ProviderKeyConfig,
  index: number
): ProviderTestPreset {
  const models = modelNames(cfg.models);
  return {
    kind,
    badge,
    providerLabel: labelFor(cfg, `${badge} #${index + 1}`),
    models,
    defaultModel: models[0],
    authOptions: [
      {
        label: maskKey(cfg.apiKey) || cfg.authIndex || labelFor(cfg, `#${index + 1}`),
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        authIndex: cfg.authIndex,
        headers: cfg.headers,
      },
    ],
  };
}

export function geminiTestPreset(cfg: GeminiKeyConfig, index: number): ProviderTestPreset {
  const models = modelNames(cfg.models);
  return {
    kind: 'gemini',
    badge: 'GEMINI',
    providerLabel: labelFor(cfg, `GEMINI #${index + 1}`),
    models,
    defaultModel: models[0],
    authOptions: [
      {
        label: maskKey(cfg.apiKey) || cfg.authIndex || labelFor(cfg, `#${index + 1}`),
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        authIndex: cfg.authIndex,
        headers: cfg.headers,
      },
    ],
  };
}

export function openaiTestPreset(cfg: OpenAIProviderConfig): ProviderTestPreset {
  const models = modelNames(cfg.models);
  const entries = cfg.apiKeyEntries ?? [];
  return {
    kind: 'openai',
    badge: 'OPENAI',
    providerLabel: cfg.name || cfg.baseUrl || 'OpenAI',
    models,
    defaultModel: (cfg.testModel || '').trim() || models[0],
    authOptions: (entries.length ? entries : [{ apiKey: '', authIndex: '' }]).map((e, i) => ({
      label: maskKey(e.apiKey) || e.authIndex || `key #${i + 1}`,
      baseUrl: cfg.baseUrl,
      apiKey: e.apiKey,
      authIndex: e.authIndex,
      headers: { ...(cfg.headers ?? {}), ...(e.headers ?? {}) },
    })),
  };
}

export function ampcodeTestPreset(cfg: AmpcodeConfig): ProviderTestPreset {
  const models = (cfg.modelMappings ?? [])
    .map((m) => String(m?.from ?? '').trim())
    .filter(Boolean);
  // Prefer the per-key mappings; fall back to the single upstream key.
  const keys = (cfg.upstreamApiKeys ?? []).map((m) => m.upstreamApiKey).filter(Boolean);
  if (!keys.length && String(cfg.upstreamApiKey ?? '').trim()) {
    keys.push(String(cfg.upstreamApiKey).trim());
  }
  return {
    kind: 'ampcode',
    badge: 'AMPCODE',
    providerLabel: cfg.upstreamUrl || 'Ampcode',
    models,
    defaultModel: models[0],
    authOptions: (keys.length ? keys : ['']).map((key, i) => ({
      label: maskKey(key) || `key #${i + 1}`,
      baseUrl: cfg.upstreamUrl,
      apiKey: key,
    })),
  };
}
