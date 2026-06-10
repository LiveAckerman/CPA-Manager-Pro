/**
 * Provider connectivity test — shared request builder + result classifier.
 *
 * Centralises the per-provider differences for the "test connection" feature
 * used by ProviderTestModal (list page + every edit page). Every test goes
 * through the existing `apiCallApi.request()` -> CPA `/api-call`, which makes
 * the REAL upstream call (substituting `$TOKEN$` from a saved account's
 * authIndex, or using the draft's plaintext key).
 */
import {
  buildClaudeMessagesEndpoint,
  buildOpenAIChatCompletionsEndpoint,
  normalizeOpenAIBaseUrl,
} from '@/components/providers/utils';
import type { ApiCallRequest, ApiCallResult } from '@/services/api/apiCall';
import { getApiCallErrorMessage } from '@/services/api/apiCall';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { hasHeader } from '@/utils/headers';
import { CODEX_USAGE_URL } from '@/utils/quota/constants';

export type ProviderKind = 'openai' | 'claude' | 'gemini' | 'codex' | 'vertex' | 'ampcode';

export const PROVIDER_TEST_TIMEOUT_MS = 30_000;
export const PROVIDER_TEST_PROMPT = 'Hi';

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/** One auth source for a test (a provider, or one key of a multi-key provider). */
export interface ProviderTestAuth {
  baseUrl?: string;
  /** Plaintext key for an unsaved draft. Empty for OAuth/saved accounts. */
  apiKey?: string;
  /** Saved account index in CPA — CPA substitutes the real token for `$TOKEN$`. */
  authIndex?: string;
  /** Custom headers from the provider config. */
  headers?: Record<string, string>;
}

export type TestRequestResult =
  | { request: ApiCallRequest; expectText: boolean }
  | { unsupported: true; reason: 'unsaved' | 'no-endpoint' };

export type TestOutcomeKind =
  | 'success'
  | 'unauthorized'
  | 'rate_limited'
  | 'upstream_error'
  | 'bad_response'
  | 'failed';

export interface TestOutcome {
  status: 'success' | 'error';
  httpStatus: number;
  kind: TestOutcomeKind;
  /** Human-readable error summary (errors only). */
  error: string;
  /** Raw response body snippet for the output panel. */
  detail: string;
}

interface ResolvedAuth {
  authIndex?: string;
  token: string;
  hasAuth: boolean;
}

function resolveAuth(auth: ProviderTestAuth): ResolvedAuth {
  const authIndex = normalizeAuthIndex(auth.authIndex) ?? undefined;
  const apiKey = (auth.apiKey ?? '').trim();
  if (apiKey) {
    return { authIndex, token: apiKey, hasAuth: true };
  }
  if (authIndex) {
    // Saved account: CPA replaces `$TOKEN$` with the real credential.
    return { authIndex, token: '$TOKEN$', hasAuth: true };
  }
  return { token: '', hasAuth: false };
}

function normalizeGeminiBaseUrl(baseUrl?: string): string {
  let trimmed = String(baseUrl ?? '').trim();
  if (!trimmed) return DEFAULT_GEMINI_BASE_URL;
  trimmed = trimmed.replace(/\/?v0\/management\/?$/i, '');
  trimmed = trimmed.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;
  // strip a trailing /v1beta so we can append it ourselves
  trimmed = trimmed.replace(/\/v1beta$/i, '');
  return trimmed;
}

function openAICompatibleRequest(
  auth: ProviderTestAuth,
  model: string
): TestRequestResult {
  const url = buildOpenAIChatCompletionsEndpoint(auth.baseUrl ?? '');
  if (!url) return { unsupported: true, reason: 'no-endpoint' };
  const resolved = resolveAuth(auth);
  if (!resolved.hasAuth) return { unsupported: true, reason: 'unsaved' };

  const header: Record<string, string> = { 'Content-Type': 'application/json', ...(auth.headers ?? {}) };
  if (!hasHeader(header, 'authorization')) {
    header.Authorization = `Bearer ${resolved.token}`;
  }
  return {
    expectText: true,
    request: {
      method: 'POST',
      authIndex: resolved.authIndex,
      url,
      header,
      data: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROVIDER_TEST_PROMPT }],
        max_tokens: 8,
        stream: false,
      }),
    },
  };
}

/**
 * Build the `apiCallApi.request` payload for a real test call, or report that
 * the provider can't be tested in its current state (e.g. an unsaved OAuth
 * draft with no token yet).
 */
export function buildTestRequest(
  kind: ProviderKind,
  auth: ProviderTestAuth,
  model: string
): TestRequestResult {
  switch (kind) {
    case 'openai':
    case 'ampcode':
    case 'vertex':
      // OpenAI-compatible upstream (best-effort for vertex/ampcode).
      return openAICompatibleRequest(auth, model);

    case 'claude': {
      const url = buildClaudeMessagesEndpoint(auth.baseUrl ?? '');
      if (!url) return { unsupported: true, reason: 'no-endpoint' };
      const resolved = resolveAuth(auth);
      if (!resolved.hasAuth) return { unsupported: true, reason: 'unsaved' };

      const header: Record<string, string> = { 'Content-Type': 'application/json', ...(auth.headers ?? {}) };
      if (!hasHeader(header, 'anthropic-version')) header['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
      if (!hasHeader(header, 'x-api-key')) header['x-api-key'] = resolved.token;
      return {
        expectText: true,
        request: {
          method: 'POST',
          authIndex: resolved.authIndex,
          url,
          header,
          data: JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: 'user', content: PROVIDER_TEST_PROMPT }],
          }),
        },
      };
    }

    case 'gemini': {
      const base = normalizeGeminiBaseUrl(auth.baseUrl);
      if (!base) return { unsupported: true, reason: 'no-endpoint' };
      const resolved = resolveAuth(auth);
      if (!resolved.hasAuth) return { unsupported: true, reason: 'unsaved' };

      const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const header: Record<string, string> = { 'Content-Type': 'application/json', ...(auth.headers ?? {}) };
      if (!hasHeader(header, 'x-goog-api-key')) header['x-goog-api-key'] = resolved.token;
      return {
        expectText: true,
        request: {
          method: 'POST',
          authIndex: resolved.authIndex,
          url,
          header,
          data: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: PROVIDER_TEST_PROMPT }] }],
            generationConfig: { maxOutputTokens: 8 },
          }),
        },
      };
    }

    case 'codex': {
      const resolved = resolveAuth(auth);
      // API-key codex with a base URL → OpenAI-compatible probe.
      if ((auth.apiKey ?? '').trim() && normalizeOpenAIBaseUrl(auth.baseUrl ?? '')) {
        return openAICompatibleRequest(auth, model);
      }
      // OAuth codex account → reuse the safe codex usage probe (saved only).
      // The usage endpoint returns JSON usage data, not an assistant reply, so
      // a 2xx alone means the account is reachable.
      if (!resolved.authIndex) return { unsupported: true, reason: 'unsaved' };
      const header: Record<string, string> = { ...(auth.headers ?? {}) };
      if (!hasHeader(header, 'authorization')) header.Authorization = 'Bearer $TOKEN$';
      return {
        expectText: false,
        request: { method: 'GET', authIndex: resolved.authIndex, url: CODEX_USAGE_URL, header },
      };
    }

    default:
      return { unsupported: true, reason: 'no-endpoint' };
  }
}

/**
 * Pull the assistant's reply text out of a model response, trying every known
 * shape (OpenAI chat, Claude messages, Responses API, Gemini). Returns null if
 * none matches — e.g. the body is an HTML page, an error envelope, or anything
 * that isn't a real model reply.
 */
export function extractAssistantText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const join = (parts: any): string =>
    Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';

  // OpenAI chat completions
  const choice = Array.isArray(b.choices) ? b.choices[0] : undefined;
  if (choice) {
    const c = choice.message?.content ?? choice.text ?? choice.delta?.content;
    if (typeof c === 'string' && c) return c;
    const joined = join(c);
    if (joined) return joined;
  }
  // Claude /v1/messages
  if (Array.isArray(b.content)) {
    const text = join(b.content);
    if (text) return text;
  }
  // Responses API
  if (typeof b.output_text === 'string' && b.output_text) return b.output_text;
  if (Array.isArray(b.output)) {
    const text = b.output.flatMap((o: any) => o?.content ?? []).map((p: any) => p?.text ?? '').join('');
    if (text) return text;
  }
  // Gemini generateContent
  const cand = Array.isArray(b.candidates) ? b.candidates[0] : undefined;
  if (cand) {
    const text = join(cand.content?.parts);
    if (text) return text;
  }
  return null;
}

const looksLikeHtml = (text: string): boolean =>
  /^\s*(?:<!doctype html|<html|<head|<body|<!--)/i.test(text);

/**
 * Map a real `/api-call` result to a friendly outcome for the modal.
 * `expectText` = the test should yield an assistant reply (chat-style). A 2xx
 * that carries no model reply (HTML challenge page, login redirect, wrong
 * endpoint) is treated as a FAILURE, not a success.
 */
export function classifyResult(result: ApiCallResult, expectText: boolean): TestOutcome {
  const code = result.statusCode;
  const bodyText = result.bodyText || '';

  if (result.hasStatusCode && code >= 200 && code < 300) {
    if (!expectText) {
      // Usage probe etc. — reachable 2xx is success; no reply expected.
      return { status: 'success', httpStatus: code, kind: 'success', error: '', detail: '' };
    }
    const reply = extractAssistantText(result.body);
    if (reply && reply.trim()) {
      return { status: 'success', httpStatus: code, kind: 'success', error: '', detail: reply.trim().slice(0, 1200) };
    }
    // 2xx but no model reply → not a real success.
    return {
      status: 'error',
      httpStatus: code,
      kind: 'bad_response',
      error: looksLikeHtml(bodyText) ? 'html' : 'no-reply',
      detail: bodyText.slice(0, 400),
    };
  }

  let kind: TestOutcomeKind = 'failed';
  if (code === 401 || code === 403) kind = 'unauthorized';
  else if (code === 429) kind = 'rate_limited';
  else if (code >= 500) kind = 'upstream_error';

  return {
    status: 'error',
    httpStatus: code,
    kind,
    error: getApiCallErrorMessage(result),
    detail: bodyText.slice(0, 400),
  };
}
