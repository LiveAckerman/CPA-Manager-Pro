import { describe, expect, it } from 'vitest';

import type { ApiCallResult } from '@/services/api/apiCall';
import { classifyResult, extractAssistantText } from './providerTest';

const res = (statusCode: number, body: unknown, bodyText?: string): ApiCallResult => ({
  statusCode,
  hasStatusCode: true,
  header: {},
  body,
  bodyText: bodyText ?? (typeof body === 'string' ? body : JSON.stringify(body)),
});

describe('extractAssistantText', () => {
  it('OpenAI chat completions', () => {
    expect(extractAssistantText({ choices: [{ message: { content: 'Hi' } }] })).toBe('Hi');
  });
  it('Claude messages', () => {
    expect(extractAssistantText({ content: [{ type: 'text', text: 'Hi there' }] })).toBe('Hi there');
  });
  it('Responses API', () => {
    expect(extractAssistantText({ output_text: 'yo' })).toBe('yo');
    expect(
      extractAssistantText({ output: [{ content: [{ type: 'output_text', text: 'yo2' }] }] })
    ).toBe('yo2');
  });
  it('Gemini generateContent', () => {
    expect(
      extractAssistantText({ candidates: [{ content: { parts: [{ text: 'gem' }] } }] })
    ).toBe('gem');
  });
  it('HTML / unknown shapes → null', () => {
    expect(extractAssistantText('<html><body>nope</body></html>')).toBeNull();
    expect(extractAssistantText({ error: { message: 'bad' } })).toBeNull();
    expect(extractAssistantText(null)).toBeNull();
  });
});

describe('classifyResult', () => {
  it('200 with a real reply → success, detail = reply only', () => {
    const out = classifyResult(res(200, { content: [{ type: 'text', text: 'Hi! How can I help' }] }), true);
    expect(out.status).toBe('success');
    expect(out.detail).toBe('Hi! How can I help');
  });

  it('200 returning HTML → FAILURE (the reported bug)', () => {
    const out = classifyResult(res(200, '<!doctype html><html>...</html>'), true);
    expect(out.status).toBe('error');
    expect(out.kind).toBe('bad_response');
    expect(out.error).toBe('html');
  });

  it('200 with a JSON error envelope → failure', () => {
    const out = classifyResult(res(200, { error: { message: 'nope' } }), true);
    expect(out.status).toBe('error');
    expect(out.kind).toBe('bad_response');
  });

  it('200 usage probe (expectText=false) → success even without reply', () => {
    const out = classifyResult(res(200, { usage: {} }), false);
    expect(out.status).toBe('success');
  });

  it('401 → unauthorized; 429 → rate_limited; 503 → upstream_error', () => {
    expect(classifyResult(res(401, { error: 'bad key' }), true).kind).toBe('unauthorized');
    expect(classifyResult(res(429, {}), true).kind).toBe('rate_limited');
    expect(classifyResult(res(503, {}), true).kind).toBe('upstream_error');
  });
});
