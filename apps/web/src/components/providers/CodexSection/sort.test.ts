import { describe, expect, it } from 'vitest';
import type { ProviderKeyConfig } from '@/types';
import { buildRecentRequestCompositeKey } from '@/utils/recentRequests';
import type { ProviderRecentUsageMap } from '../utils';
import { sortCodexConfigs, sortCodexConfigsByPriority } from './sort';

describe('sortCodexConfigsByPriority', () => {
  const configs: ProviderKeyConfig[] = [
    { apiKey: 'first', baseUrl: 'https://first.example.com/v1', priority: 3 },
    { apiKey: 'unset', baseUrl: 'https://unset.example.com/v1' },
    { apiKey: 'highest', baseUrl: 'https://highest.example.com/v1', priority: 10 },
    { apiKey: 'also-highest', baseUrl: 'https://also-highest.example.com/v1', priority: 10 },
    { apiKey: 'lowest', baseUrl: 'https://lowest.example.com/v1', priority: -1 },
    {
      apiKey: 'disabled-highest',
      baseUrl: 'https://disabled-highest.example.com/v1',
      priority: 99,
      excludedModels: ['*'],
    },
    {
      apiKey: 'disabled-unset',
      baseUrl: 'https://disabled-unset.example.com/v1',
      excludedModels: ['*'],
    },
  ];

  it('sorts enabled priorities high to low by default and treats missing priority as 0', () => {
    expect(sortCodexConfigsByPriority(configs).map((item) => item.originalIndex)).toEqual([
      2, 3, 0, 1, 4, 5, 6,
    ]);
  });

  it('sorts enabled priorities low to high when requested and treats missing priority as 0', () => {
    expect(sortCodexConfigsByPriority(configs, 'asc').map((item) => item.originalIndex)).toEqual([
      4, 1, 0, 2, 3, 5, 6,
    ]);
  });

  it('preserves the source list order for equal effective priorities', () => {
    const tiedConfigs: ProviderKeyConfig[] = [
      { apiKey: 'a', priority: 2 },
      { apiKey: 'b', priority: 2 },
      { apiKey: 'c' },
      { apiKey: 'd' },
    ];

    expect(sortCodexConfigsByPriority(tiedConfigs).map((item) => item.config.apiKey)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('sortCodexConfigs', () => {
  const configs: ProviderKeyConfig[] = [
    {
      apiKey: 'alpha-key',
      baseUrl: 'https://alpha.example.com/v1',
      prefix: 'alpha',
      priority: 2,
      models: [{ name: 'gpt-5' }],
    },
    {
      apiKey: 'disabled-key',
      baseUrl: 'https://disabled.example.com/v1',
      prefix: 'disabled',
      priority: 99,
      excludedModels: ['*'],
      models: [{ name: 'gpt-5' }],
    },
    {
      apiKey: 'beta-key',
      baseUrl: 'https://beta.example.com/v1',
      prefix: 'beta',
      priority: 6,
      models: [{ name: 'gpt-5.5' }],
    },
    {
      apiKey: 'unset-key',
      baseUrl: 'https://unset.example.com/v1',
      models: [{ name: 'gpt-5.5' }],
    },
  ];

  const buildUsage = (): ProviderRecentUsageMap =>
    new Map([
      [
        'codex',
        new Map([
          [
            buildRecentRequestCompositeKey('https://alpha.example.com/v1', 'alpha-key'),
            { success: 10, failed: 0, recentRequests: [{ success: 3, failed: 0 }] },
          ],
          [
            buildRecentRequestCompositeKey('https://beta.example.com/v1', 'beta-key'),
            { success: 20, failed: 0, recentRequests: [{ success: 8, failed: 0 }] },
          ],
          [
            buildRecentRequestCompositeKey('https://disabled.example.com/v1', 'disabled-key'),
            { success: 99, failed: 0, recentRequests: [{ success: 99, failed: 0 }] },
          ],
        ]),
      ],
    ]);

  it('sorts by the selected OpenAI-style option while disabled providers stay at the bottom', () => {
    expect(
      sortCodexConfigs(configs, {
        sortOption: 'recent-success',
        sortDirection: 'desc',
        usageByProvider: buildUsage(),
      }).map((item) => item.originalIndex)
    ).toEqual([2, 0, 3, 1]);

    expect(
      sortCodexConfigs(configs, {
        sortOption: 'name',
        sortDirection: 'asc',
        usageByProvider: buildUsage(),
      }).map((item) => item.originalIndex)
    ).toEqual([0, 2, 3, 1]);
  });

  it('filters by selected models before sorting and keeps matching disabled providers last', () => {
    expect(
      sortCodexConfigs(configs, {
        sortOption: 'priority',
        sortDirection: 'desc',
        selectedModels: new Set(['gpt-5.5']),
      }).map((item) => item.originalIndex)
    ).toEqual([2, 3]);

    expect(
      sortCodexConfigs(configs, {
        sortOption: 'priority',
        sortDirection: 'desc',
        selectedModels: new Set(['gpt-5']),
      }).map((item) => item.originalIndex)
    ).toEqual([0, 1]);
  });
});
