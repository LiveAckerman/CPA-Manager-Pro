import { describe, expect, it } from 'vitest';
import type { UsageDetailWithEndpoint } from '@/utils/usage';
import { buildEventRows } from './eventRows';

const buildRows = (overrides: Partial<UsageDetailWithEndpoint> = {}) =>
  buildEventRows(
    [
      {
        timestamp: '2026-05-19T10:00:00Z',
        source: 'alice@example.com',
        auth_index: 'auth-1',
        latency_ms: 1500,
        ttft_ms: 500,
        tokens: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
        },
        failed: false,
        __modelName: 'gpt-5.4',
        __endpoint: 'POST /v1/chat/completions',
        __endpointMethod: 'POST',
        __endpointPath: '/v1/chat/completions',
        __timestampMs: Date.parse('2026-05-19T10:00:00Z'),
        ...overrides,
      },
    ],
    new Map(),
    new Map(),
    { byAuthIndex: new Map(), bySource: new Map() },
    new Map(),
    {},
    new Map()
  );

describe('buildEventRows', () => {
  it('calculates output tokens per second from total latency', () => {
    const [row] = buildRows();

    expect(row.latencyMs).toBe(1500);
    expect(row.ttftMs).toBe(500);
    expect(row.tokensPerSecond).toBeCloseTo(20 / 1.5);
  });

  it('does not let TTFT change output tokens per second', () => {
    const [withoutTTFT] = buildRows({ ttft_ms: undefined });
    const [smallTTFT] = buildRows({ ttft_ms: 100 });
    const [invalidTTFT] = buildRows({ ttft_ms: 2000 });

    expect(withoutTTFT.tokensPerSecond).toBeCloseTo(20 / 1.5);
    expect(smallTTFT.tokensPerSecond).toBeCloseTo(20 / 1.5);
    expect(invalidTTFT.tokensPerSecond).toBeCloseTo(20 / 1.5);
  });

  it('does not calculate tokens per second without output tokens or total latency', () => {
    const [noOutput] = buildRows({ tokens: { output_tokens: 0 } });
    const [noLatency] = buildRows({ latency_ms: undefined });
    const [zeroLatency] = buildRows({ latency_ms: 0 });

    expect(noOutput.tokensPerSecond).toBeNull();
    expect(noLatency.tokensPerSecond).toBeNull();
    expect(zeroLatency.tokensPerSecond).toBeNull();
  });

  it('keeps CPA executor and service tier metadata searchable', () => {
    const [row] = buildRows({
      executor_type: 'codex',
      service_tier: 'priority',
      reasoning_effort: 'medium',
    });

    expect(row.executorType).toBe('codex');
    expect(row.serviceTier).toBe('priority');
    expect(row.searchText).toContain('codex');
    expect(row.searchText).toContain('priority');
    expect(row.searchText).toContain('medium');
  });
});
