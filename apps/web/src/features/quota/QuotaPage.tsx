/**
 * Quota management page - coordinates the three quota sections.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore } from '@/stores';
import { authFilesApi, configFileApi } from '@/services/api';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { IconSearch } from '@/components/ui/icons';
import {
  QuotaSection,
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
  XAI_CONFIG
} from '@/components/quota';
import type { QuotaSortMode } from '@/components/quota/quotaConfigs';
import type { AuthFileItem } from '@/types';
import {
  readQuotaPageUiState,
  writeQuotaPageUiState,
  type QuotaSectionType,
  type QuotaSectionViewMode,
} from './quotaPageUiState';
import styles from './QuotaPage.module.scss';

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const initialUiState = useRef(readQuotaPageUiState());

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState(() => initialUiState.current.searchQuery);
  const [sortMode, setSortMode] = useState<QuotaSortMode>(() => initialUiState.current.sortMode);
  const [sectionViewModes, setSectionViewModes] = useState(() => ({
    ...initialUiState.current.sectionViewModes,
  }));

  const disableControls = connectionStatus !== 'connected';
  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('quota_management.sort_default') },
      { value: 'name-asc', label: t('quota_management.sort_name_asc') },
      { value: 'plan-desc', label: t('quota_management.sort_plan_desc') },
      { value: 'plan-asc', label: t('quota_management.sort_plan_asc') }
    ],
    [t]
  );

  const loadConfig = useCallback(async () => {
    try {
      await configFileApi.fetchConfigYaml();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError((prev) => prev || errorMessage);
    }
  }, [t]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      setFiles(data?.files || []);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadConfig(), loadFiles()]);
  }, [loadConfig, loadFiles]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    loadFiles();
    loadConfig();
  }, [loadFiles, loadConfig]);

  useEffect(() => {
    writeQuotaPageUiState({
      searchQuery,
      sortMode,
      sectionViewModes,
    });
  }, [searchQuery, sectionViewModes, sortMode]);

  const getSectionViewMode = useCallback(
    (sectionType: QuotaSectionType): QuotaSectionViewMode =>
      sectionViewModes[sectionType] ?? 'paged',
    [sectionViewModes]
  );

  const setSectionViewMode = useCallback(
    (sectionType: QuotaSectionType, viewMode: QuotaSectionViewMode) => {
      setSectionViewModes((current) => ({
        ...current,
        [sectionType]: viewMode,
      }));
    },
    []
  );

  return (
    <div className={styles.container}>
      {error && <div className={styles.errorBox}>{error}</div>}

      <div className={styles.toolbar}>
        <div className={styles.toolbarField}>
          <Input
            label={t('quota_management.search_label')}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('quota_management.search_placeholder')}
            rightElement={<IconSearch size={16} />}
            aria-label={t('quota_management.search_label')}
          />
        </div>
        <div className={`${styles.toolbarField} ${styles.sortField}`}>
          <label htmlFor="quota-sort-mode" className={styles.toolbarLabel}>
            {t('quota_management.sort_label')}
          </label>
          <Select
            id="quota-sort-mode"
            value={sortMode}
            options={sortOptions}
            onChange={(value) => setSortMode(value as QuotaSortMode)}
            ariaLabel={t('quota_management.sort_label')}
            fullWidth
          />
        </div>
      </div>

      <QuotaSection
        config={CODEX_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(CODEX_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(CODEX_CONFIG.type, viewMode)}
      />
      <QuotaSection
        config={CLAUDE_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(CLAUDE_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(CLAUDE_CONFIG.type, viewMode)}
      />
      <QuotaSection
        config={ANTIGRAVITY_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(ANTIGRAVITY_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(ANTIGRAVITY_CONFIG.type, viewMode)}
      />
      <QuotaSection
        config={GEMINI_CLI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(GEMINI_CLI_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(GEMINI_CLI_CONFIG.type, viewMode)}
      />
      <QuotaSection
        config={KIMI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(KIMI_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(KIMI_CONFIG.type, viewMode)}
      />
      <QuotaSection
        config={XAI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(XAI_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(XAI_CONFIG.type, viewMode)}
      />
    </div>
  );
}
