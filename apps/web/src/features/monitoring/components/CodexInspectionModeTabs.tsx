import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import styles from '../CodexInspectionPage.module.scss';

export type CodexInspectionMode = 'local' | 'server';

type CodexInspectionModeTabsProps = {
  activeMode: CodexInspectionMode;
};

const MODES: ReadonlyArray<{
  mode: CodexInspectionMode;
  path: string;
  labelKey: string;
}> = [
  {
    mode: 'local',
    path: '/codex-inspection',
    labelKey: 'monitoring.codex_inspection_mode_local',
  },
  {
    mode: 'server',
    path: '/codex-inspection/server',
    labelKey: 'monitoring.codex_inspection_mode_server',
  },
];

export function CodexInspectionModeTabs({ activeMode }: CodexInspectionModeTabsProps) {
  const { t } = useTranslation();
  const availability = usePanelFeatureAvailability();
  const activeLabel = t(
    activeMode === 'local'
      ? 'monitoring.codex_inspection_mode_local'
      : 'monitoring.codex_inspection_mode_server'
  );
  const visibleModes = MODES.filter(
    (item) =>
      item.mode === 'local' ||
      item.mode === activeMode ||
      availability.checking ||
      availability.serverCodexInspectionAvailable
  );

  return (
    <section
      className={styles.modeSwitchPanel}
      aria-label={t('monitoring.codex_inspection_mode_label')}
    >
      <div className={styles.modeSwitchMain}>
        <div
          className={styles.modeSwitchTabs}
          role="tablist"
          aria-label={t('monitoring.codex_inspection_mode_label')}
        >
          {visibleModes.map((item) => {
            const active = activeMode === item.mode;
            return (
              <Link
                key={item.mode}
                to={item.path}
                role="tab"
                aria-selected={active}
                className={`${styles.modeSwitchTab} ${active ? styles.modeSwitchTabActive : ''}`}
              >
                {t(item.labelKey)}
              </Link>
            );
          })}
        </div>

        <div className={styles.modeSwitchCopy}>
          <span className={styles.modeSwitchEyebrow}>
            {t('monitoring.codex_inspection_mode_current', { mode: activeLabel })}
          </span>
          <p>
            {t(
              activeMode === 'local'
                ? 'monitoring.codex_inspection_mode_local_desc'
                : 'monitoring.codex_inspection_mode_server_desc'
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
