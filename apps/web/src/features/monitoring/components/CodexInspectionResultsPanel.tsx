import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import {
  type CodexInspectionAction,
  type CodexInspectionResultItem,
  type CodexInspectionRunResult,
  isExecutableAction,
} from '@/features/monitoring/codexInspection';
import {
  ACTION_FILTERS,
  type CodexInspectionPaginationState,
  formatActionLabel,
  formatCurrentStateLabel,
  formatPercent,
  type ActionFilter,
} from '@/features/monitoring/model/codexInspectionPresentation';
import { Panel } from '@/features/monitoring/components/CodexInspectionPanels';
import styles from '../CodexInspectionPage.module.scss';

type CodexInspectionResultsPanelProps = {
  result: CodexInspectionRunResult | null;
  filteredResults: CodexInspectionResultItem[];
  suggestedResults: CodexInspectionResultItem[];
  pendingActionCount: number;
  filterCounts: Record<ActionFilter, number>;
  actionFilter: ActionFilter;
  pagination: CodexInspectionPaginationState<CodexInspectionResultItem>;
  pageSize: number;
  pageSizeOptions: readonly number[];
  executing: boolean;
  isInspectionInFlight: boolean;
  t: TFunction;
  onActionFilterChange: (filter: ActionFilter) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onExecutePlanned: () => void;
  onExecuteSingle: (item: CodexInspectionResultItem) => void;
  filterLabel: (filter: ActionFilter) => string;
};

const actionToneClass: Record<CodexInspectionAction, string> = {
  keep: styles.actionKeep,
  delete: styles.actionDelete,
  disable: styles.actionDisable,
  enable: styles.actionEnable,
  reauth: styles.actionReauth,
};

export function CodexInspectionResultsPanel({
  result,
  filteredResults,
  suggestedResults,
  pendingActionCount,
  filterCounts,
  actionFilter,
  pagination,
  pageSize,
  pageSizeOptions,
  executing,
  isInspectionInFlight,
  t,
  onActionFilterChange,
  onPageChange,
  onPageSizeChange,
  onExecutePlanned,
  onExecuteSingle,
  filterLabel,
}: CodexInspectionResultsPanelProps) {
  return (
    <Panel
      title={t('monitoring.codex_inspection_results_title')}
      subtitle={t('monitoring.codex_inspection_results_desc')}
      extra={
        <div className={styles.resultsHeaderActions}>
          <Button
            variant={pendingActionCount > 0 ? 'danger' : 'primary'}
            size="sm"
            onClick={onExecutePlanned}
            loading={executing}
            disabled={!result || isInspectionInFlight || executing || pendingActionCount === 0}
          >
            {executing
              ? t('monitoring.codex_inspection_executing')
              : t('monitoring.codex_inspection_execute_now')}
          </Button>
        </div>
      }
    >
      {result ? (
        <>
          <div className={styles.filterRow}>
            <div className={styles.segmentedControl}>
              {ACTION_FILTERS.map((filter) => {
                const count = filterCounts[filter];
                const isActive = actionFilter === filter;
                return (
                  <button
                    key={filter}
                    type="button"
                    className={`${styles.segmentButton} ${isActive ? styles.segmentButtonActive : ''}`}
                    onClick={() => onActionFilterChange(filter)}
                  >
                    <span>{filterLabel(filter)}</span>
                    <span className={styles.segmentCount}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <colgroup>
                <col className={styles.accountColumn} />
                <col className={styles.stateColumn} />
                <col className={styles.httpColumn} />
                <col className={styles.usageColumn} />
                <col className={styles.actionColumn} />
                <col className={styles.operationColumn} />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('monitoring.account_label')}</th>
                  <th>{t('monitoring.codex_inspection_current_state')}</th>
                  <th>{t('monitoring.codex_inspection_http_status')}</th>
                  <th>{t('monitoring.codex_inspection_used_percent')}</th>
                  <th>{t('monitoring.codex_inspection_next_action')}</th>
                  <th>{t('common.action')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.length > 0 ? (
                  filteredResults.map((item) => (
                    <tr key={item.key}>
                      <td>
                        <div className={styles.primaryCell}>
                          <span className={styles.primaryAccount}>{item.displayAccount}</span>
                          <small className={styles.primaryFile}>
                            {item.fileName}
                            {item.authIndex ? (
                              <span className={styles.primaryIndex}>{` \u00b7 #${item.authIndex}`}</span>
                            ) : null}
                          </small>
                          {item.actionReason ? (
                            <small className={styles.primaryReason}>{item.actionReason}</small>
                          ) : null}
                          {item.error ? (
                            <small className={styles.primaryError}>{item.error}</small>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`${styles.stateChip} ${
                            item.disabled ? styles.stateDisabled : styles.stateEnabled
                          }`}
                        >
                          {formatCurrentStateLabel(item, t)}
                        </span>
                      </td>
                      <td className={styles.monoCell}>
                        {item.statusCode === null ? '--' : item.statusCode}
                      </td>
                      <td className={styles.monoCell}>{formatPercent(item.usedPercent)}</td>
                      <td>
                        <span className={`${styles.actionBadge} ${actionToneClass[item.action]}`}>
                          {formatActionLabel(item.action, t)}
                        </span>
                      </td>
                      <td>
                        {isExecutableAction(item) ? (
                          <Button
                            size="sm"
                            variant={item.action === 'delete' ? 'danger' : 'secondary'}
                            onClick={() => onExecuteSingle(item)}
                            disabled={isInspectionInFlight || executing}
                          >
                            {formatActionLabel(item.action, t)}
                          </Button>
                        ) : (
                          <span className={styles.primaryReason}>
                            {t('monitoring.codex_inspection_manual_required')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>
                      <div className={styles.emptyBlockSmall}>
                        {suggestedResults.length === 0
                          ? t('monitoring.codex_inspection_no_pending_actions')
                          : t('monitoring.codex_inspection_no_pending_actions')}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {pagination.totalPages > 1 ? (
            <div className={styles.resultPaginationBar}>
              <div className={styles.resultPaginationInfo}>
                {t('monitoring.pagination_info', {
                  current: pagination.currentPage,
                  total: pagination.totalPages,
                  start: pagination.startItem,
                  end: pagination.endItem,
                  count: pagination.count,
                })}
              </div>
              <div className={styles.resultPaginationControls}>
                <div className={styles.resultPageSizeField}>
                  <span>{t('monitoring.page_size_label')}</span>
                  <Select
                    className={styles.resultPageSizeSelect}
                    triggerClassName={styles.resultPageSizeSelectTrigger}
                    value={String(pageSize)}
                    options={pageSizeOptions.map((size) => ({
                      value: String(size),
                      label: t('monitoring.page_size_option', { count: size }),
                    }))}
                    onChange={(value) => {
                      const parsed = Number.parseInt(value, 10);
                      onPageSizeChange(Number.isFinite(parsed) && parsed > 0 ? parsed : pageSize);
                    }}
                    ariaLabel={t('monitoring.page_size_label')}
                    fullWidth={false}
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onPageChange(Math.max(1, pagination.currentPage - 1))}
                  disabled={pagination.currentPage <= 1}
                >
                  {t('monitoring.pagination_prev')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    onPageChange(Math.min(pagination.totalPages, pagination.currentPage + 1))
                  }
                  disabled={pagination.currentPage >= pagination.totalPages}
                >
                  {t('monitoring.pagination_next')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className={styles.emptyBlock}>{t('monitoring.codex_inspection_empty')}</div>
      )}
    </Panel>
  );
}
