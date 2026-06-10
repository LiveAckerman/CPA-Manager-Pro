import { describe, expect, it } from 'vitest';
import type { OpenAIProviderConfig } from '@/types';
import { sortOpenAIProvidersByPriority } from './sort';

describe('sortOpenAIProvidersByPriority', () => {
  const providers: OpenAIProviderConfig[] = [
    {
      name: 'unset',
      baseUrl: 'https://unset.example.com/v1',
      apiKeyEntries: [],
    },
    {
      name: 'middle',
      baseUrl: 'https://middle.example.com/v1',
      apiKeyEntries: [],
      priority: 3,
    },
    {
      name: 'highest',
      baseUrl: 'https://highest.example.com/v1',
      apiKeyEntries: [],
      priority: 10,
    },
    {
      name: 'lowest',
      baseUrl: 'https://lowest.example.com/v1',
      apiKeyEntries: [],
      priority: -1,
    },
  ];

  it('sorts priorities high to low by default and treats missing priority as 0', () => {
    expect(sortOpenAIProvidersByPriority(providers).map((item) => item.originalIndex)).toEqual([
      2, 1, 0, 3,
    ]);
  });

  it('sorts priorities low to high when requested and treats missing priority as 0', () => {
    expect(
      sortOpenAIProvidersByPriority(providers, 'asc').map((item) => item.originalIndex)
    ).toEqual([3, 0, 1, 2]);
  });

  it('uses the existing name fallback when effective priorities are equal', () => {
    const tiedProviders: OpenAIProviderConfig[] = [
      {
        name: 'alpha',
        baseUrl: 'https://alpha.example.com/v1',
        apiKeyEntries: [],
        priority: 5,
      },
      {
        name: 'zulu',
        baseUrl: 'https://zulu.example.com/v1',
        apiKeyEntries: [],
        priority: 5,
      },
    ];

    expect(sortOpenAIProvidersByPriority(tiedProviders).map((item) => item.config.name)).toEqual([
      'zulu',
      'alpha',
    ]);
  });
});
