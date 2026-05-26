/**
 * Image-pool monitoring panel.
 *
 * Aggregate diagnostic view over the in-container image-service's account
 * pool: how many accounts are in the pool, how much image_gen quota is
 * left across them, success/fail counters, and a paginated/sortable table
 * of every account.
 *
 * Sorting is via click on the column headers (email / quota / success /
 * fail / last used). Filtering is via chip groups above the table:
 * status (fresh/active/invalid) and last-used window (1h / 24h / 7d / all).
 *
 * The refresh button forces a get_user_info() round-trip for every pool
 * account (downloading the access_token from CPA first if not cached).
 * While in flight, the button polls /api/accounts every 2 s and shows live
 * progress (N/M accounts refreshed so far) so the user knows the request
 * is still working — refresh typically takes 30-60 s for a 130-account
 * pool. See `imagePool.ts` for the safety argument (no refresh_token
 * rotation anywhere in the path).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  imagePoolApi,
  type ImagePoolAccount,
  type ImagePoolAccountStatus,
  type ImagePoolRefreshResult,
} from '@/services/api/imagePool';
import { MonitoringPanel } from './MonitoringPanel';
import styles from '@/features/monitoring/MonitoringCenterPage.module.scss';

// --- types -----------------------------------------------------------------

type SortKey = 'email' | 'quota' | 'success' | 'fail' | 'last-used';
type SortDirection = 'asc' | 'desc';
type RecentUsedFilter = 'all' | '1h' | '24h' | '7d' | '30d';

const ALL_STATUSES: ImagePoolAccountStatus[] = ['fresh', 'active', 'invalid'];

const PAGE_SIZE = 20;
const REFRESH_POLL_INTERVAL_MS = 2000;

// --- helpers ---------------------------------------------------------------

// Mask email like useMonitoringData.maskEmailLike (which isn't exported).
const maskEmail = (email: string): string => {
  const trimmed = (email || '').trim();
  const match = trimmed.match(/^([^@\s]{1,3})[^@\s]*@(.+)$/);
  if (!match) return trimmed;
  return `${match[1]}***@${match[2]}`;
};

const formatLastUsed = (epochSeconds: number, locale: string): string => {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return '—';
  try {
    return new Date(epochSeconds * 1000).toLocaleString(locale);
  } catch {
    return '—';
  }
};

// Quota cell colour. 0 = red, 1-5 = amber, >5 = green, unknown = muted.
const quotaTone = (quota: number, unknown: boolean): 'good' | 'warn' | 'bad' | null => {
  if (unknown) return null;
  if (quota <= 0) return 'bad';
  if (quota <= 5) return 'warn';
  return 'good';
};

const statusTone = (status: ImagePoolAccountStatus): 'good' | 'warn' | 'bad' => {
  switch (status) {
    case 'active':
      return 'good';
    case 'fresh':
      return 'warn';
    case 'invalid':
    default:
      return 'bad';
  }
};

const toneClass = (tone: 'good' | 'warn' | 'bad' | null | undefined): string => {
  if (!tone) return '';
  return tone === 'good' ? styles.tonegood : tone === 'warn' ? styles.tonewarn : styles.tonebad;
};

// Filter accounts by last-used window. 'all' returns everything regardless of
// last_used_at. Other windows include accounts whose last_used_at is within
// that many milliseconds of "now"; accounts with no last_used_at are excluded
// because they don't satisfy "recently used" by any definition.
const RECENT_USED_WINDOWS_MS: Record<Exclude<RecentUsedFilter, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const passesRecentUsedFilter = (
  a: ImagePoolAccount,
  filter: RecentUsedFilter,
  nowMs: number
): boolean => {
  if (filter === 'all') return true;
  if (!a.last_used_at) return false;
  return nowMs - a.last_used_at * 1000 <= RECENT_USED_WINDOWS_MS[filter];
};

// --- component -------------------------------------------------------------

export function MonitoringImagePoolBlock() {
  const { t, i18n } = useTranslation();

  const [accounts, setAccounts] = useState<ImagePoolAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshResult, setLastRefreshResult] = useState<ImagePoolRefreshResult | null>(null);

  // Sort state: which column + direction. Default to "quota desc" — most
  // useful at-a-glance (where's the spare capacity).
  const [sortKey, setSortKey] = useState<SortKey>('quota');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Filter state. statusFilter holds the set of statuses to INCLUDE; all 3
  // by default = no filter active. recentUsedFilter is a single-select chip
  // group ('all' / time window).
  const [statusFilter, setStatusFilter] = useState<Set<ImagePoolAccountStatus>>(
    () => new Set(ALL_STATUSES)
  );
  const [recentUsedFilter, setRecentUsedFilter] = useState<RecentUsedFilter>('all');

  const [page, setPage] = useState(1);

  const refreshPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await imagePoolApi.list();
      setAccounts(data.items || []);
      return data.items || [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  // Cleanup the poll interval on unmount so a navigation away mid-refresh
  // doesn't leak timers.
  useEffect(
    () => () => {
      if (refreshPollRef.current) clearInterval(refreshPollRef.current);
    },
    []
  );

  const handleRefreshClick = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    // Initialise progress chip with 0/total so it shows immediately rather
    // than blank for the first poll cycle.
    setRefreshProgress({ done: 0, total: accounts.length });

    // Poll the SERVER-side refresh-status endpoint every 2s. The image
    // service tracks the exact count under its account-dict lock, so the
    // panel gets a real "N / M" — client-side guesses don't work because
    // after the startup refresh every account already has status=active,
    // making "moved out of fresh" useless as a progress signal.
    if (refreshPollRef.current) clearInterval(refreshPollRef.current);
    refreshPollRef.current = setInterval(() => {
      void (async () => {
        try {
          const status = await imagePoolApi.refreshStatus();
          if (status.in_progress) {
            setRefreshProgress({
              done: status.done ?? 0,
              total: status.total ?? 0,
            });
          }
        } catch {
          /* swallow — final result will surface any real error */
        }
      })();
    }, REFRESH_POLL_INTERVAL_MS);

    try {
      const result = await imagePoolApi.refresh(true);
      setLastRefreshResult(result);
      await fetchAccounts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      if (refreshPollRef.current) {
        clearInterval(refreshPollRef.current);
        refreshPollRef.current = null;
      }
      setRefreshProgress(null);
      setRefreshing(false);
    }
  }, [accounts, fetchAccounts]);

  // Aggregate stats — derived from the unfiltered list (whole pool view).
  const stats = useMemo(() => {
    const total = accounts.length;
    const knownQuota = accounts.filter((a) => !a.quota_unknown);
    const unknownQuota = total - knownQuota.length;
    const totalRemaining = knownQuota.reduce((sum, a) => sum + (a.quota || 0), 0);
    const totalSuccess = accounts.reduce((sum, a) => sum + (a.success || 0), 0);
    const totalFail = accounts.reduce((sum, a) => sum + (a.fail || 0), 0);
    const totalInflight = accounts.reduce((sum, a) => sum + (a.inflight || 0), 0);
    const statusCounts: Record<ImagePoolAccountStatus, number> = {
      fresh: 0,
      active: 0,
      invalid: 0,
    };
    accounts.forEach((a) => {
      if (a.status in statusCounts) statusCounts[a.status]++;
    });
    return {
      total,
      knownQuota: knownQuota.length,
      unknownQuota,
      totalRemaining,
      totalSuccess,
      totalFail,
      totalInflight,
      statusCounts,
    };
  }, [accounts]);

  // Filter pipeline: status set + recent-used window. nowMs is captured per
  // recompute so the relative windows ("last 24h") track when filters change.
  const filtered = useMemo(() => {
    const nowMs = Date.now();
    return accounts.filter(
      (a) =>
        statusFilter.has(a.status) &&
        passesRecentUsedFilter(a, recentUsedFilter, nowMs)
    );
  }, [accounts, statusFilter, recentUsedFilter]);

  const sortedAccounts = useMemo(() => {
    const copy = [...filtered];
    const dir = sortDirection === 'desc' ? -1 : 1;
    switch (sortKey) {
      case 'email':
        copy.sort((a, b) => dir * (a.email || '').localeCompare(b.email || ''));
        break;
      case 'quota':
        copy.sort((a, b) => {
          // Unknown sinks to end regardless of direction — they're not "0
          // left", they're "we don't know yet".
          if (a.quota_unknown && !b.quota_unknown) return 1;
          if (!a.quota_unknown && b.quota_unknown) return -1;
          return dir * ((a.quota || 0) - (b.quota || 0));
        });
        break;
      case 'success':
        copy.sort((a, b) => dir * ((a.success || 0) - (b.success || 0)));
        break;
      case 'fail':
        copy.sort((a, b) => dir * ((a.fail || 0) - (b.fail || 0)));
        break;
      case 'last-used':
        copy.sort((a, b) => dir * ((a.last_used_at || 0) - (b.last_used_at || 0)));
        break;
    }
    return copy;
  }, [filtered, sortKey, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedAccounts.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pageItems = sortedAccounts.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  // Reset to page 1 whenever sort or filters change — keeps the user
  // looking at the top of the newly-ordered list.
  useEffect(() => {
    setPage(1);
  }, [sortKey, sortDirection, statusFilter, recentUsedFilter]);

  // Click handler for column header. Toggle direction on same column; on
  // different column, switch to that column with sensible default direction.
  const handleSortHeaderClick = useCallback(
    (nextKey: SortKey) => {
      if (sortKey === nextKey) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(nextKey);
        // Numeric columns default desc (high → low), email default asc (A → Z).
        setSortDirection(nextKey === 'email' ? 'asc' : 'desc');
      }
    },
    [sortKey]
  );

  const toggleStatusFilter = useCallback((status: ImagePoolAccountStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        if (next.size === 1) {
          // Don't allow zero statuses — that'd hide everything; toggle back
          // to "all" instead so the chip click has a sensible end state.
          return new Set(ALL_STATUSES);
        }
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

  const statusLabel = (status: ImagePoolAccountStatus): string =>
    t(`monitoring.image_pool_status_${status}`);

  // --- inline style fragments ---------------------------------------------

  const refreshSummaryStyle: CSSProperties = {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
    fontSize: 12,
    color: 'var(--monitor-muted, #888)',
  };
  const refreshChipStyle = (tone: 'good' | 'warn' | 'bad' | null): CSSProperties => ({
    padding: '2px 8px',
    borderRadius: 999,
    fontWeight: 600,
    background:
      tone === 'good'
        ? 'color-mix(in srgb, var(--monitor-green) 12%, transparent)'
        : tone === 'warn'
          ? 'color-mix(in srgb, var(--monitor-amber) 12%, transparent)'
          : tone === 'bad'
            ? 'color-mix(in srgb, var(--monitor-red) 12%, transparent)'
            : 'transparent',
    color:
      tone === 'good'
        ? 'var(--monitor-green)'
        : tone === 'warn'
          ? 'var(--monitor-amber)'
          : tone === 'bad'
            ? 'var(--monitor-red)'
            : 'inherit',
  });
  const filterChipBase: CSSProperties = {
    padding: '4px 12px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid transparent',
    userSelect: 'none',
    transition: 'background 120ms ease, border-color 120ms ease',
  };
  const filterChipStyle = (active: boolean, tone?: 'good' | 'warn' | 'bad'): CSSProperties => {
    if (active && tone) {
      return {
        ...filterChipBase,
        background:
          tone === 'good'
            ? 'color-mix(in srgb, var(--monitor-green) 16%, transparent)'
            : tone === 'warn'
              ? 'color-mix(in srgb, var(--monitor-amber) 16%, transparent)'
              : 'color-mix(in srgb, var(--monitor-red) 16%, transparent)',
        color:
          tone === 'good'
            ? 'var(--monitor-green)'
            : tone === 'warn'
              ? 'var(--monitor-amber)'
              : 'var(--monitor-red)',
        borderColor: 'currentColor',
      };
    }
    if (active) {
      return {
        ...filterChipBase,
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        borderColor: 'currentColor',
      };
    }
    return {
      ...filterChipBase,
      color: 'var(--monitor-muted, #888)',
      borderColor: 'var(--monitor-line, #ddd)',
      background: 'transparent',
    };
  };
  const sortHeaderStyle = (active: boolean): CSSProperties => ({
    cursor: 'pointer',
    userSelect: 'none',
    color: active ? 'var(--monitor-text, inherit)' : undefined,
    fontWeight: active ? 700 : undefined,
    whiteSpace: 'nowrap',
  });
  const tableCellTone: CSSProperties = { fontWeight: 600 };

  const sortIndicator = (key: SortKey): string =>
    sortKey === key ? (sortDirection === 'desc' ? ' ▼' : ' ▲') : '';

  // Status filter "all selected" detection — used to render the "all" master
  // chip as active so the user can tell at a glance that no filter is on.
  const allStatusesSelected = ALL_STATUSES.every((s) => statusFilter.has(s));

  const recentUsedOptions: RecentUsedFilter[] = ['all', '1h', '24h', '7d', '30d'];

  return (
    <MonitoringPanel
      title={t('monitoring.image_pool_title')}
      subtitle={t('monitoring.image_pool_subtitle')}
      extra={
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {error ? (
            <span
              role="button"
              tabIndex={0}
              onClick={() => setError(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setError(null);
              }}
              title={`${error}\n\n${t('monitoring.image_pool_error_dismiss_hint')}`}
              style={{
                ...refreshChipStyle('bad'),
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                maxWidth: 360,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              <span aria-hidden>⚠</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {error}
              </span>
              <span aria-hidden style={{ opacity: 0.7, marginLeft: 2 }}>×</span>
            </span>
          ) : null}
          {refreshing && refreshProgress ? (
            <span style={refreshSummaryStyle}>
              <span>{t('monitoring.image_pool_refresh_progress_prefix')}</span>
              <span style={refreshChipStyle('warn')}>
                {refreshProgress.done} / {refreshProgress.total}
              </span>
            </span>
          ) : null}
          {!refreshing && lastRefreshResult ? (
            <span style={refreshSummaryStyle}>
              <span>{t('monitoring.image_pool_last_refresh_prefix')}</span>
              <span style={refreshChipStyle('good')}>✓ {lastRefreshResult.refreshed}</span>
              <span style={refreshChipStyle(lastRefreshResult.invalidated ? 'warn' : null)}>
                ⊘ {lastRefreshResult.invalidated}
              </span>
              <span style={refreshChipStyle(lastRefreshResult.errors ? 'bad' : null)}>
                ⚠ {lastRefreshResult.errors}
              </span>
            </span>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleRefreshClick()}
            disabled={refreshing || loading}
          >
            {refreshing
              ? t('monitoring.image_pool_refreshing')
              : t('monitoring.image_pool_refresh_button')}
          </Button>
        </div>
      }
    >
      {/* Summary cards — unchanged from previous iteration. */}
      <div className={styles.summarySub}>
        <Card className={`${styles.summaryCard} ${styles.summaryCardSecondary}`}>
          <span className={styles.summaryLabel}>{t('monitoring.image_pool_total_accounts')}</span>
          <strong className={styles.summaryValue}>{stats.total}</strong>
          <span className={styles.summaryMeta}>
            <span className={styles.tonegood}>● {stats.statusCounts.active}</span>{' '}
            <span className={styles.tonewarn}>● {stats.statusCounts.fresh}</span>{' '}
            <span className={styles.tonebad}>● {stats.statusCounts.invalid}</span>
          </span>
        </Card>
        <Card className={`${styles.summaryCard} ${styles.summaryCardSecondary}`}>
          <span className={styles.summaryLabel}>{t('monitoring.image_pool_total_remaining_quota')}</span>
          <strong className={`${styles.summaryValue} ${stats.totalRemaining > 0 ? styles.tonegood : ''}`}>
            {stats.totalRemaining}
          </strong>
          <span className={styles.summaryMeta}>
            {t('monitoring.image_pool_quota_meta', {
              known: stats.knownQuota,
              unknown: stats.unknownQuota,
            })}
          </span>
        </Card>
        <Card className={`${styles.summaryCard} ${styles.summaryCardSecondary}`}>
          <span className={styles.summaryLabel}>{t('monitoring.image_pool_total_success')}</span>
          <strong className={`${styles.summaryValue} ${styles.tonegood}`}>{stats.totalSuccess}</strong>
          <span className={styles.summaryMeta}>
            {t('monitoring.image_pool_inflight', { count: stats.totalInflight })}
          </span>
        </Card>
        <Card className={`${styles.summaryCard} ${styles.summaryCardSecondary}`}>
          <span className={styles.summaryLabel}>{t('monitoring.image_pool_total_fail')}</span>
          <strong className={`${styles.summaryValue} ${stats.totalFail > 0 ? styles.tonebad : ''}`}>
            {stats.totalFail}
          </strong>
          <span className={styles.summaryMeta}>
            {stats.totalSuccess + stats.totalFail > 0
              ? `${((stats.totalSuccess / (stats.totalSuccess + stats.totalFail)) * 100).toFixed(1)}% ${t('monitoring.image_pool_success_rate')}`
              : '—'}
          </span>
        </Card>
      </div>

      {/* Filter row */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 16,
          marginTop: 16,
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--monitor-muted, #888)', marginRight: 4 }}>
            {t('monitoring.image_pool_filter_status_label')}
          </span>
          {ALL_STATUSES.map((s) => (
            <span
              key={s}
              role="button"
              tabIndex={0}
              onClick={() => toggleStatusFilter(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') toggleStatusFilter(s);
              }}
              style={filterChipStyle(statusFilter.has(s), statusTone(s))}
            >
              {statusLabel(s)} <span style={{ opacity: 0.6 }}>({stats.statusCounts[s]})</span>
            </span>
          ))}
          {!allStatusesSelected ? (
            <span
              role="button"
              tabIndex={0}
              onClick={() => setStatusFilter(new Set(ALL_STATUSES))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setStatusFilter(new Set(ALL_STATUSES));
              }}
              style={{
                ...filterChipBase,
                color: 'var(--monitor-muted, #888)',
                background: 'transparent',
                border: 'none',
                fontSize: 12,
                textDecoration: 'underline',
              }}
            >
              {t('monitoring.image_pool_filter_clear')}
            </span>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--monitor-muted, #888)', marginRight: 4 }}>
            {t('monitoring.image_pool_filter_recent_used_label')}
          </span>
          {recentUsedOptions.map((opt) => (
            <span
              key={opt}
              role="button"
              tabIndex={0}
              onClick={() => setRecentUsedFilter(opt)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setRecentUsedFilter(opt);
              }}
              style={filterChipStyle(recentUsedFilter === opt)}
            >
              {t(`monitoring.image_pool_recent_${opt.replace('-', '_')}`)}
            </span>
          ))}
        </div>

        <span style={{ marginLeft: 'auto', color: 'var(--monitor-muted, #888)', fontSize: 13 }}>
          {t('monitoring.image_pool_pagination_summary', {
            start: sortedAccounts.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1,
            end: Math.min(currentPage * PAGE_SIZE, sortedAccounts.length),
            total: sortedAccounts.length,
          })}
        </span>
      </div>

      {/* Table — clickable column headers for sorting */}
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th onClick={() => handleSortHeaderClick('email')} style={sortHeaderStyle(sortKey === 'email')}>
                {t('monitoring.image_pool_col_email')}{sortIndicator('email')}
              </th>
              <th>{t('monitoring.image_pool_col_status')}</th>
              <th onClick={() => handleSortHeaderClick('quota')} style={sortHeaderStyle(sortKey === 'quota')}>
                {t('monitoring.image_pool_col_quota')}{sortIndicator('quota')}
              </th>
              <th onClick={() => handleSortHeaderClick('success')} style={sortHeaderStyle(sortKey === 'success')}>
                {t('monitoring.image_pool_col_success')}{sortIndicator('success')}
              </th>
              <th onClick={() => handleSortHeaderClick('fail')} style={sortHeaderStyle(sortKey === 'fail')}>
                {t('monitoring.image_pool_col_fail')}{sortIndicator('fail')}
              </th>
              <th>{t('monitoring.image_pool_col_inflight')}</th>
              <th onClick={() => handleSortHeaderClick('last-used')} style={sortHeaderStyle(sortKey === 'last-used')}>
                {t('monitoring.image_pool_col_last_used')}{sortIndicator('last-used')}
              </th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{ textAlign: 'center', padding: 24, color: 'var(--monitor-muted, #888)' }}
                >
                  {loading ? t('common.loading') : t('monitoring.image_pool_empty')}
                </td>
              </tr>
            ) : (
              pageItems.map((acct) => {
                const sTone = statusTone(acct.status);
                const qTone = quotaTone(acct.quota, acct.quota_unknown);
                const failTone = acct.fail > 0 ? 'bad' : null;
                return (
                  <tr key={acct.file_name}>
                    <td title={acct.email}>{maskEmail(acct.email)}</td>
                    <td>
                      <span className={`${styles.statusBadge} ${toneClass(sTone)}`}>
                        {statusLabel(acct.status)}
                      </span>
                    </td>
                    <td>
                      <span className={toneClass(qTone)} style={tableCellTone}>
                        {acct.quota_unknown ? '?' : acct.quota}
                      </span>
                    </td>
                    <td>
                      {acct.success > 0 ? (
                        <span className={styles.tonegood} style={tableCellTone}>{acct.success}</span>
                      ) : (
                        <span style={{ color: 'var(--monitor-muted, #888)' }}>0</span>
                      )}
                    </td>
                    <td>
                      <span className={toneClass(failTone)} style={tableCellTone}>{acct.fail}</span>
                    </td>
                    <td>{acct.inflight > 0 ? acct.inflight : '—'}</td>
                    <td>{formatLastUsed(acct.last_used_at, i18n.language)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', marginTop: 16 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
          >
            {t('monitoring.image_pool_prev_page')}
          </Button>
          <span style={{ fontSize: 13, color: 'var(--monitor-muted, #888)' }}>
            {t('monitoring.image_pool_page_x_of_y', { current: currentPage, total: totalPages })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
          >
            {t('monitoring.image_pool_next_page')}
          </Button>
        </div>
      ) : null}
    </MonitoringPanel>
  );
}
