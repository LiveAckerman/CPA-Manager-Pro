import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconEye, IconEyeOff, IconX } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { ManagerBindingStatus } from '../ConfigPage';
import styles from '../ConfigPage.module.scss';

type ManagerConfigPanelProps = {
  managerLoading: boolean;
  managerSaving: boolean;
  panelHostedByUsageService: boolean | null;
  detectedPanelBase: string;
  managerRuntimeModeLabel: string;
  managerServiceBase: string;
  managerAdminKey: string;
  managerCPAManagementKey: string;
  managerHasBoundCPAManagementKey: boolean;
  currentCPAApiBase: string;
  managerBoundCPABase: string;
  managerBindingStatus: ManagerBindingStatus;
  disableControls: boolean;
  canConfigureRequestMonitoring: boolean;
  managerRequestMonitoringEnabled: boolean;
  managerCollectorMode: string;
  managerCollectorModeOptions: Array<{ value: string; label: string }>;
  managerPollIntervalMs: string;
  managerBatchSize: string;
  managerQueryLimit: string;
  managerRetentionSeconds: number;
  managerConfigSourceLabel: string;
  managerUsageStatisticsEnabled: boolean;
  onRefresh: () => void;
  onManagerServiceBaseChange: (value: string) => void;
  onManagerAdminKeyChange: (value: string) => void;
  onManagerCPAManagementKeyChange: (value: string) => void;
  onRequestMonitoringChange: (value: boolean) => void;
  onCollectorModeChange: (value: string) => void;
  onPollIntervalMsChange: (value: string) => void;
  onBatchSizeChange: (value: string) => void;
  onQueryLimitChange: (value: string) => void;
};

export function ManagerConfigPanel({
  managerLoading,
  managerSaving,
  panelHostedByUsageService,
  detectedPanelBase,
  managerRuntimeModeLabel,
  managerServiceBase,
  managerAdminKey,
  managerCPAManagementKey,
  managerHasBoundCPAManagementKey,
  currentCPAApiBase,
  managerBoundCPABase,
  managerBindingStatus,
  disableControls,
  canConfigureRequestMonitoring,
  managerRequestMonitoringEnabled,
  managerCollectorMode,
  managerCollectorModeOptions,
  managerPollIntervalMs,
  managerBatchSize,
  managerQueryLimit,
  managerRetentionSeconds,
  managerConfigSourceLabel,
  managerUsageStatisticsEnabled,
  onRefresh,
  onManagerServiceBaseChange,
  onManagerAdminKeyChange,
  onManagerCPAManagementKeyChange,
  onRequestMonitoringChange,
  onCollectorModeChange,
  onPollIntervalMsChange,
  onBatchSizeChange,
  onQueryLimitChange,
}: ManagerConfigPanelProps) {
  const { t } = useTranslation();
  const [cpaKeyRevealed, setCpaKeyRevealed] = useState(false);
  const isExternalPanel = panelHostedByUsageService !== true;
  const bindingNoteClass =
    managerBindingStatus === 'matched'
      ? styles.managerStatusSuccess
      : managerBindingStatus === 'mismatched'
        ? styles.managerStatusDanger
        : styles.managerStatusWarning;
  const cpaKeyInputDisabled = disableControls || managerLoading;
  const cpaKeyHasInput = managerCPAManagementKey.length > 0;
  const showCpaKeySavingHint = managerSaving && managerCPAManagementKey.trim().length > 0;

  return (
    <div className={styles.managerConfigPanel}>
      <div className={styles.managerConfigHeader}>
        <div>
          <h2>{t('config_management.manager.title')}</h2>
          <p>{t('config_management.manager.boundary_hint')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onRefresh} loading={managerLoading}>
          {t('common.refresh')}
        </Button>
      </div>

      <section className={styles.managerSection}>
        <div className={styles.managerSectionHeader}>
          <div>
            <h3>{t('config_management.manager.runtime_title')}</h3>
            <p>
              {panelHostedByUsageService === true
                ? t('config_management.manager.runtime_embedded_hint')
                : t('config_management.manager.runtime_external_hint')}
            </p>
          </div>
          <span className={styles.managerRuntimeBadge}>{managerRuntimeModeLabel}</span>
        </div>

        {panelHostedByUsageService === true ? (
          <div className={styles.managerReadonlyGrid}>
            <div>
              <span>{t('config_management.manager.service_base')}</span>
              <strong>{detectedPanelBase}</strong>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.managerConfigGrid}>
              <Input
                label={t('config_management.manager.external_service_base')}
                placeholder="http://127.0.0.1:18317"
                value={managerServiceBase}
                onChange={(event) => onManagerServiceBaseChange(event.target.value)}
                disabled={disableControls || managerLoading}
                hint={t('config_management.manager.external_service_hint')}
              />
              <Input
                label={t('config_management.manager.admin_key_label')}
                type="password"
                placeholder={t('config_management.manager.admin_key_placeholder')}
                value={managerAdminKey}
                onChange={(event) => onManagerAdminKeyChange(event.target.value)}
                disabled={disableControls || managerLoading}
                autoComplete="off"
                hint={t('config_management.manager.admin_key_hint')}
              />
            </div>
            <div className={styles.managerReadonlyGrid}>
              <div>
                <span>{t('config_management.manager.current_cpa_base')}</span>
                <strong>{currentCPAApiBase || t('config_management.manager.not_bound')}</strong>
              </div>
              <div>
                <span>{t('config_management.manager.bound_cpa_base')}</span>
                <strong>{managerBoundCPABase || t('config_management.manager.not_bound')}</strong>
              </div>
            </div>
          </>
        )}

        {isExternalPanel && managerBindingStatus !== 'unknown' ? (
          <div className={`${styles.managerStatusNote} ${bindingNoteClass}`}>
            {t(`config_management.manager.binding_${managerBindingStatus}`)}
          </div>
        ) : null}
      </section>

      <section className={styles.managerSection}>
        <div className={styles.managerSectionHeader}>
          <div>
            <h3>{t('config_management.manager.cpa_management_key_section_title')}</h3>
            <p>{t('config_management.manager.cpa_management_key_section_hint')}</p>
          </div>
          <span
            className={`${styles.managerKeyBindingBadge} ${
              managerHasBoundCPAManagementKey
                ? styles.managerKeyBindingBadgeBound
                : styles.managerKeyBindingBadgeUnbound
            }`}
          >
            {managerHasBoundCPAManagementKey
              ? t('config_management.manager.cpa_management_key_binding_bound')
              : t('config_management.manager.cpa_management_key_binding_unbound')}
          </span>
        </div>

        <Input
          label={t('config_management.manager.cpa_management_key_label')}
          type={cpaKeyRevealed ? 'text' : 'password'}
          placeholder={t('config_management.manager.cpa_management_key_placeholder')}
          value={managerCPAManagementKey}
          onChange={(event) => onManagerCPAManagementKeyChange(event.target.value)}
          disabled={cpaKeyInputDisabled}
          autoComplete="off"
          className={styles.managerCpaKeyInput}
          rightElement={
            <div className={styles.managerKeyInputActions}>
              <button
                type="button"
                className={styles.managerKeyIconButton}
                onClick={() => setCpaKeyRevealed((prev) => !prev)}
                disabled={cpaKeyInputDisabled || !cpaKeyHasInput}
                aria-label={t(
                  cpaKeyRevealed
                    ? 'config_management.manager.cpa_management_key_hide'
                    : 'config_management.manager.cpa_management_key_reveal'
                )}
                title={t(
                  cpaKeyRevealed
                    ? 'config_management.manager.cpa_management_key_hide'
                    : 'config_management.manager.cpa_management_key_reveal'
                )}
              >
                {cpaKeyRevealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
              <button
                type="button"
                className={styles.managerKeyIconButton}
                onClick={() => {
                  onManagerCPAManagementKeyChange('');
                  setCpaKeyRevealed(false);
                }}
                disabled={cpaKeyInputDisabled || !cpaKeyHasInput}
                aria-label={t('config_management.manager.cpa_management_key_clear')}
                title={t('config_management.manager.cpa_management_key_clear')}
              >
                <IconX size={16} />
              </button>
            </div>
          }
        />

        {showCpaKeySavingHint ? (
          <div className={styles.managerKeySavingHint}>
            {t('config_management.manager.cpa_management_key_saving')}
          </div>
        ) : null}
      </section>

      <section className={styles.managerSection}>
        <div className={styles.managerSectionHeader}>
          <div>
            <h3>{t('config_management.manager.request_monitoring_title')}</h3>
            <p>{t('config_management.manager.request_monitoring_hint')}</p>
          </div>
          <ToggleSwitch
            label={t('config_management.manager.request_monitoring_enabled')}
            labelPosition="left"
            checked={managerRequestMonitoringEnabled}
            onChange={onRequestMonitoringChange}
            disabled={disableControls || managerLoading || !canConfigureRequestMonitoring}
          />
        </div>

        {!canConfigureRequestMonitoring ? (
          <div className={styles.managerDependencyNote}>
            {t('config_management.manager.request_monitoring_dependency')}
          </div>
        ) : null}

        <div className={styles.managerQueueNote}>
          {t('config_management.manager.request_monitoring_queue_note')}
        </div>

        <div className={styles.managerConfigGrid}>
          <div className={styles.managerField}>
            <span className={styles.managerFieldLabel}>
              {t('config_management.manager.collector_mode')}
            </span>
            <Select
              value={managerCollectorMode}
              options={managerCollectorModeOptions}
              triggerClassName={styles.managerSelectTrigger}
              onChange={onCollectorModeChange}
              disabled={
                disableControls ||
                managerLoading ||
                !managerRequestMonitoringEnabled ||
                !canConfigureRequestMonitoring
              }
              ariaLabel={t('config_management.manager.collector_mode')}
            />
          </div>
          <Input
            label={t('config_management.manager.poll_interval_ms')}
            type="number"
            min="1"
            placeholder="500"
            value={managerPollIntervalMs}
            onChange={(event) => onPollIntervalMsChange(event.target.value)}
            disabled={
              disableControls ||
              managerLoading ||
              !managerRequestMonitoringEnabled ||
              !canConfigureRequestMonitoring
            }
            hint={t('config_management.manager.poll_interval_hint', {
              seconds: managerRetentionSeconds,
            })}
          />
          <Input
            label={t('config_management.manager.batch_size')}
            type="number"
            min="1"
            placeholder="100"
            value={managerBatchSize}
            onChange={(event) => onBatchSizeChange(event.target.value)}
            disabled={
              disableControls ||
              managerLoading ||
              !managerRequestMonitoringEnabled ||
              !canConfigureRequestMonitoring
            }
          />
          <Input
            label={t('config_management.manager.query_limit')}
            type="number"
            min="1"
            placeholder="50000"
            value={managerQueryLimit}
            onChange={(event) => onQueryLimitChange(event.target.value)}
            disabled={
              disableControls ||
              managerLoading ||
              !managerRequestMonitoringEnabled ||
              !canConfigureRequestMonitoring
            }
          />
        </div>
      </section>

      <div className={styles.managerMetaGrid}>
        <div>
          <span>{t('config_management.manager.config_source')}</span>
          <strong>{managerConfigSourceLabel}</strong>
        </div>
        <div>
          <span>{t('config_management.manager.cpa_usage_enabled')}</span>
          <strong>{managerUsageStatisticsEnabled ? t('common.enabled') : t('common.disabled')}</strong>
        </div>
        <div>
          <span>{t('config_management.manager.cpa_retention')}</span>
          <strong>
            {t('config_management.manager.cpa_retention_value', {
              seconds: managerRetentionSeconds,
            })}
          </strong>
        </div>
      </div>
    </div>
  );
}
