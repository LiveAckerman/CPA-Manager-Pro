import type { OpenAIProviderConfig } from '@/types';
import {
  getOpenAIProviderRecentWindowStats,
  type ProviderRecentUsageMap,
} from '../utils';

export type OpenAIProviderSortDirection = 'asc' | 'desc';
export type OpenAIProviderSortOption = 'priority' | 'name' | 'recent-success';

export interface IndexedOpenAIProvider {
  config: OpenAIProviderConfig;
  originalIndex: number;
}

interface SortOpenAIProvidersOptions {
  sortOption?: OpenAIProviderSortOption;
  sortDirection?: OpenAIProviderSortDirection;
  usageByProvider?: ProviderRecentUsageMap;
  selectedModels?: ReadonlySet<string>;
}

const getPriority = (config: OpenAIProviderConfig) => {
  const priority = config.priority;
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0;
};

const applyDirection = (value: number, direction: OpenAIProviderSortDirection) =>
  direction === 'desc' ? -value : value;

const compareByName = (
  left: OpenAIProviderConfig,
  right: OpenAIProviderConfig,
  direction: OpenAIProviderSortDirection
) => applyDirection(left.name.localeCompare(right.name), direction);

const matchesSelectedModels = (
  config: OpenAIProviderConfig,
  selectedModels: ReadonlySet<string>
) => {
  if (selectedModels.size === 0) return true;
  return config.models?.some((model) => selectedModels.has(model.name)) ?? false;
};

export const sortOpenAIProviders = (
  providers: OpenAIProviderConfig[],
  {
    sortOption = 'priority',
    sortDirection = 'desc',
    usageByProvider = new Map(),
    selectedModels = new Set<string>(),
  }: SortOpenAIProvidersOptions = {}
): IndexedOpenAIProvider[] => {
  const sorted = providers
    .map((config, originalIndex) => ({ config, originalIndex }))
    .filter(({ config }) => matchesSelectedModels(config, selectedModels));
  const providerStats =
    sortOption === 'recent-success'
      ? new Map(
          sorted.map(({ config, originalIndex }) => [
            originalIndex,
            getOpenAIProviderRecentWindowStats(config, usageByProvider),
          ])
        )
      : null;

  return sorted.sort((left, right) => {
    switch (sortOption) {
      case 'name': {
        const diff = compareByName(left.config, right.config, sortDirection);
        if (diff !== 0) return diff;
        break;
      }
      case 'recent-success': {
        const leftSuccess = providerStats?.get(left.originalIndex)?.success ?? 0;
        const rightSuccess = providerStats?.get(right.originalIndex)?.success ?? 0;
        const diff = leftSuccess - rightSuccess;
        if (diff !== 0) return applyDirection(diff, sortDirection);
        const nameDiff = compareByName(left.config, right.config, sortDirection);
        if (nameDiff !== 0) return nameDiff;
        break;
      }
      case 'priority':
      default: {
        const diff = getPriority(left.config) - getPriority(right.config);
        if (diff !== 0) return applyDirection(diff, sortDirection);
        const nameDiff = compareByName(left.config, right.config, sortDirection);
        if (nameDiff !== 0) return nameDiff;
        break;
      }
    }

    return left.originalIndex - right.originalIndex;
  });
};

export const sortOpenAIProvidersByPriority = (
  providers: OpenAIProviderConfig[],
  direction: OpenAIProviderSortDirection = 'desc'
): IndexedOpenAIProvider[] =>
  sortOpenAIProviders(providers, { sortOption: 'priority', sortDirection: direction });
