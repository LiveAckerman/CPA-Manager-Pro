import type { ProviderKeyConfig } from '@/types';
import {
  getProviderRecentWindowStats,
  hasDisableAllModelsRule,
  type ProviderRecentUsageMap,
} from '../utils';

export type CodexProviderSortDirection = 'asc' | 'desc';
export type CodexProviderSortOption = 'priority' | 'name' | 'recent-success';

export interface IndexedCodexProviderConfig {
  config: ProviderKeyConfig;
  originalIndex: number;
}

interface SortCodexConfigsOptions {
  sortOption?: CodexProviderSortOption;
  sortDirection?: CodexProviderSortDirection;
  usageByProvider?: ProviderRecentUsageMap;
  selectedModels?: ReadonlySet<string>;
}

const getPriority = (config: ProviderKeyConfig) => {
  const priority = config.priority;
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0;
};

const getSortIdentity = (config: ProviderKeyConfig) =>
  [config.prefix, config.baseUrl, config.proxyUrl, config.authIndex]
    .map((value) => String(value ?? '').trim())
    .find(Boolean) ?? '';

const applyDirection = (value: number, direction: CodexProviderSortDirection) =>
  direction === 'desc' ? -value : value;

const matchesSelectedModels = (config: ProviderKeyConfig, selectedModels: ReadonlySet<string>) => {
  if (selectedModels.size === 0) return true;
  return config.models?.some((model) => selectedModels.has(model.name)) ?? false;
};

export const sortCodexConfigs = (
  configs: ProviderKeyConfig[],
  {
    sortOption = 'priority',
    sortDirection = 'desc',
    usageByProvider = new Map(),
    selectedModels = new Set(),
  }: SortCodexConfigsOptions = {}
): IndexedCodexProviderConfig[] => {
  const indexed = configs
    .map((config, originalIndex) => ({ config, originalIndex }))
    .filter(({ config }) => matchesSelectedModels(config, selectedModels));
  const enabled = indexed.filter(({ config }) => !hasDisableAllModelsRule(config.excludedModels));
  const disabled = indexed.filter(({ config }) => hasDisableAllModelsRule(config.excludedModels));
  const recentStats =
    sortOption === 'recent-success'
      ? new Map(
          enabled.map(({ config, originalIndex }) => [
            originalIndex,
            getProviderRecentWindowStats(usageByProvider, 'codex', config.apiKey, config.baseUrl),
          ])
        )
      : null;

  const sortedEnabled = [...enabled].sort((left, right) => {
    switch (sortOption) {
      case 'name': {
        const diff = getSortIdentity(left.config).localeCompare(getSortIdentity(right.config));
        if (diff !== 0) return applyDirection(diff, sortDirection);
        break;
      }
      case 'recent-success': {
        const leftSuccess = recentStats?.get(left.originalIndex)?.success ?? 0;
        const rightSuccess = recentStats?.get(right.originalIndex)?.success ?? 0;
        const diff = leftSuccess - rightSuccess;
        if (diff !== 0) return applyDirection(diff, sortDirection);
        break;
      }
      case 'priority':
      default: {
        const diff = getPriority(left.config) - getPriority(right.config);
        if (diff !== 0) return applyDirection(diff, sortDirection);
        break;
      }
    }

    return left.originalIndex - right.originalIndex;
  });

  return [...sortedEnabled, ...disabled];
};

export const sortCodexConfigsByPriority = (
  configs: ProviderKeyConfig[],
  direction: CodexProviderSortDirection = 'desc'
): IndexedCodexProviderConfig[] =>
  sortCodexConfigs(configs, { sortOption: 'priority', sortDirection: direction });
