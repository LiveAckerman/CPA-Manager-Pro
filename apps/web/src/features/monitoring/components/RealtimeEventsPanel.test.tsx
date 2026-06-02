import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoringEventRow } from '@/features/monitoring/hooks/useMonitoringData';
import { RealtimeEventsPanel } from './RealtimeEventsPanel';

const t = ((key: string) => {
  const messages: Record<string, string> = {
    'common.loading': 'Loading',
    'common.copy': 'Copy',
    'monitoring.cache_creation_tokens_short': 'Create',
    'monitoring.cache_read_tokens_short': 'Read',
    'monitoring.column_latency': 'Latency',
    'monitoring.column_model': 'Model',
    'monitoring.column_output_tps': 'TPS',
    'monitoring.column_success_rate': 'Success',
    'monitoring.column_time': 'Time',
    'monitoring.column_type': 'Type',
    'monitoring.elapsed_short': 'Elapsed',
    'monitoring.executor_type_short': 'Executor',
    'monitoring.fail_status_code_short': 'HTTP',
    'monitoring.filter_status_failed': 'Failed only',
    'monitoring.load_more_events': 'Load more',
    'monitoring.log_rows': 'Rows',
    'monitoring.no_more_events': 'No more events',
    'monitoring.reasoning_effort': 'Effort',
    'monitoring.reasoning_effort_short': 'Effort',
    'monitoring.recent_failures': 'Failures',
    'monitoring.recent_status': 'Recent',
    'monitoring.request_status': 'Status',
    'monitoring.result_failed': 'Failed',
    'monitoring.result_success': 'Success',
    'monitoring.service_tier_short': 'Tier',
    'monitoring.this_call_cost': 'Cost',
    'monitoring.this_call_usage': 'Usage',
    'monitoring.ttft_short': 'TTFT',
  };
  return messages[key] ?? key;
}) as unknown as TFunction;

const noop = vi.fn();

type PanelRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  recentPattern: boolean[];
};

const baseRow = (overrides: Partial<PanelRow> = {}): PanelRow => ({
  id: 'row-1',
  timestamp: '2026-04-25T00:00:00Z',
  timestampMs: Date.UTC(2026, 3, 25, 12, 34, 56),
  dayKey: '2026-04-25',
  hourLabel: '00:00',
  model: 'client-gpt',
  resolvedModel: 'gpt-5.4',
  endpoint: 'POST /v1/chat/completions',
  endpointMethod: 'POST',
  endpointPath: '/v1/chat/completions',
  sourceKey: 'source:user@example.com',
  source: 'user@example.com',
  sourceMasked: 'user@example.com',
  account: 'user@example.com',
  accountMasked: 'user@example.com',
  authIndex: '0',
  authIndexMasked: '0',
  authLabel: '0',
  projectId: '',
  apiKeyHash: '',
  apiKeyLabel: '-',
  apiKeyMasked: '-',
  provider: 'openai',
  planType: '-',
  channel: 'openai',
  channelHost: '-',
  channelDisabled: false,
  failed: false,
  statsIncluded: true,
  latencyMs: 1500,
  ttftMs: 500,
  tokensPerSecond: 20,
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: 3,
  cachedTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 33,
  totalCost: 0,
  taskKey: 'task-1',
  searchText: '',
  requestCount: 1,
  successRate: 1,
  streamKey: 'stream-1',
  recentPattern: [true],
  ...overrides,
});

const renderPanel = (row: PanelRow) =>
  renderToStaticMarkup(
    <RealtimeEventsPanel
      embedded
      rows={[row]}
      pagination={{
        currentPage: 1,
        totalPages: 1,
        pageItems: [row],
        startItem: 1,
        endItem: 1,
      }}
      pageSize={10}
      scopedFailureCount={row.failed ? 1 : 0}
      failedOnlyActive={false}
      eventsHasMore={false}
      eventsLoadingMore={false}
      overallLoading={false}
      hasPrices={false}
      locale="en-US"
      emptyState={<span>empty</span>}
      t={t}
      onToggleFailedOnly={noop}
      onPageChange={noop}
      onPageSizeChange={noop}
      onLoadMoreEvents={noop}
    />
  );

describe('RealtimeEventsPanel', () => {
  const expectedDate = new Date(baseRow().timestampMs).toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const expectedTime = new Date(baseRow().timestampMs).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  it('renders CPA v7.1.18 usage details for failed rows', () => {
    const markup = renderPanel(
      baseRow({
        failed: true,
        successRate: 0,
        executorType: 'codex',
        reasoningEffort: 'medium',
        serviceTier: 'priority',
        cacheReadTokens: 4,
        cacheCreationTokens: 1,
        failStatusCode: 429,
        failSummary: 'rate limit exceeded',
      })
    );

    expect(markup).toContain('<th>Effort</th>');
    expect(markup).toContain('>TPS</th>');
    expect(markup).toContain('Executor: codex');
    expect(markup).toContain('medium');
    expect(markup).toContain('Tier: priority');
    expect(markup).toContain('client-gpt');
    expect(markup).toContain('gpt-5.4');
    expect(markup).not.toContain('Resolved');
    expect(markup).not.toContain('POST /v1/chat/completions');
    expect(markup).toContain('Failed');
    expect(markup).toMatch(/TTFT<\/span><span class="[^"]+">｜<\/span><span class="[^"]+">Elapsed/);
    expect(markup).toContain('500 ms');
    expect(markup).toContain('Elapsed');
    expect(markup).toContain('1.5 s');
    expect(markup).toContain('20');
    expect(markup).toContain('I 10 · O 20 · C 5');
    expect(markup).not.toContain('Read 4');
    expect(markup).not.toContain('Create 1');
    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain('aria-describedby=');
    expect(markup).toContain('aria-label="HTTP 429 · rate limit exceeded"');
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain('HTTP 429');
    expect(markup).toContain('rate limit exceeded');
  });

  it('renders safe defaults when optional usage fields are missing', () => {
    const markup = renderPanel(baseRow());

    expect(markup).not.toContain('Effort -');
    expect(markup).toContain('<th>Effort</th>');
    expect(markup).toContain('>TPS</th>');
    expect(markup).toContain('Success');
    expect(markup).toMatch(/TTFT<\/span><span class="[^"]+">｜<\/span><span class="[^"]+">Elapsed/);
    expect(markup).toContain(expectedDate);
    expect(markup).toContain(expectedTime);
    expect(markup).toContain('I 10 · O 20 · C 5');
    expect(markup).not.toContain('Read 0');
    expect(markup).not.toContain('Create 0');
    expect(markup).not.toContain('role="tooltip"');
    expect(markup).not.toContain('aria-describedby=');
    expect(markup).not.toContain('HTTP');
  });

  it('renders a ttft placeholder when ttft is missing', () => {
    const markup = renderPanel(baseRow({ ttftMs: null }));

    expect(markup).toContain('>TPS</th>');
    expect(markup).toMatch(/TTFT<\/span><span class="[^"]+">｜<\/span><span class="[^"]+">Elapsed/);
    expect(markup).not.toContain('500 ms');
    expect(markup).toContain('1.5 s');
    expect(markup).toMatch(
      /--<\/span><span class="[^"]+">｜<\/span><span class="[^"]*realtimeMetricText[^"]*realtimeMetricRight[^"]*">1\.5 s<\/span>/
    );
  });

  it('keeps latency warning and error tone classes on plain text metrics', () => {
    const warningMarkup = renderPanel(baseRow({ latencyMs: 20_000, ttftMs: 1_000 }));
    const errorMarkup = renderPanel(baseRow({ latencyMs: 35_000, ttftMs: 1_000 }));

    expect(warningMarkup).toMatch(/class="[^"]*realtimeMetricText[^"]*warnText[^"]*"/);
    expect(errorMarkup).toMatch(/class="[^"]*realtimeMetricText[^"]*badText[^"]*"/);
  });

  it('colors normal millisecond and second metrics green for both ttft and elapsed time', () => {
    const markup = renderPanel(baseRow({ latencyMs: 470, ttftMs: 120 }));

    expect(markup).toMatch(/class="[^"]*realtimeMetricText[^"]*realtimeMetricLeft[^"]*goodText[^"]*">120 ms/);
    expect(markup).toMatch(/class="[^"]*realtimeMetricText[^"]*realtimeMetricRight[^"]*goodText[^"]*">470 ms/);
  });

  it('renders residual cached tokens even when they equal cache read tokens', () => {
    const markup = renderPanel(
      baseRow({
        cachedTokens: 4,
        cacheReadTokens: 4,
        cacheCreationTokens: 1,
      })
    );

    expect(markup).toContain('C 4');
    expect(markup).not.toContain('Read 4');
    expect(markup).not.toContain('Create 1');
  });
});
