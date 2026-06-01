import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DashboardTodayRequestHealthTimeline,
  DashboardTodayRequestHealthTimelinePoint,
  DashboardTokenMixSegment,
  DashboardTrafficPoint,
} from '@/services/api/usageService';
import { formatCompactNumber } from '@/utils/usage';
import {
  buildCallsLinePath,
  buildTrafficAxisTickIndexes,
  buildVisibleTrafficTimeline,
  getTrafficMetricShare,
  isCurrentTrafficBucket,
} from './trafficOverviewChartModel';
import styles from './TrafficOverviewCard.module.scss';

interface TrafficOverviewCardProps {
  timeline: DashboardTrafficPoint[];
  trafficNowMs?: number | null;
  todayRequestHealthTimeline: DashboardTodayRequestHealthTimeline | null;
  tokenMix: DashboardTokenMixSegment[];
  totalTokens?: number;
  loading: boolean;
}

type TrafficGridStyle = CSSProperties & Record<'--bucket-count', number>;
type TrafficBarStyle = CSSProperties & Record<'--metric-share' | '--metric-min-height', number | string>;
type TokenRankStyle = CSSProperties & Record<'--rank-share' | '--rank-color', number | string>;
type HealthCellStyle = CSSProperties & Record<'--cell-intensity', number>;

const fallbackHealthBucketMs = 10 * 60 * 1000;

const formatHour = (bucketMs: number, locale: string) =>
  new Date(bucketMs).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });

const tokenLabelMap: Record<string, string> = {
  input: 'dashboard.token_mix_input',
  output: 'dashboard.token_mix_output',
  reasoning: 'dashboard.token_mix_reasoning',
  cached: 'dashboard.token_mix_cached',
};

const tokenColorMap: Record<string, string> = {
  input: '#3b82f6',
  output: '#10b981',
  reasoning: '#8b5cf6',
  cached: '#f59e0b',
};

const visibleTokenMixKeys = new Set(['input', 'output', 'reasoning', 'cached']);

const healthToneClassMap: Record<string, string> = {
  future: 'healthFuture',
  empty: 'healthEmpty',
  good: 'healthGood',
  warn: 'healthWarn',
  bad: 'healthBad',
};

const formatPercent = (value: number | undefined, digits = 1) => {
  if (value === undefined || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
};

const formatMinuteLabel = (bucketMs: number | undefined, locale: string) => {
  if (!bucketMs) return '--';
  return new Date(bucketMs).toLocaleTimeString(locale, {
    minute: '2-digit',
  });
};

const buildHealthTitle = (
  point: DashboardTodayRequestHealthTimelinePoint,
  locale: string,
  t: (key: string) => string
) => {
  const time = formatHour(point.bucket_ms, locale);
  return `${time} · ${t('dashboard.traffic_calls')}: ${formatCompactNumber(point.calls)} · ${t('dashboard.request_health_success')}: ${formatCompactNumber(point.success)} · ${t('dashboard.request_health_failure')}: ${formatCompactNumber(point.failure)} · ${t('dashboard.success_rate')}: ${formatPercent(point.success_rate)}`;
};

export function TrafficOverviewCard({
  timeline,
  trafficNowMs,
  todayRequestHealthTimeline,
  tokenMix,
  totalTokens: todayTotalTokens,
  loading,
}: TrafficOverviewCardProps) {
  const { t, i18n } = useTranslation();
  const [activeTokenSegment, setActiveTokenSegment] = useState<DashboardTokenMixSegment | null>(null);
  const visibleTimeline = buildVisibleTrafficTimeline(timeline, trafficNowMs);
  const hasData = visibleTimeline.some((point) => point.calls > 0 || point.tokens > 0);
  const visibleTokenMix = tokenMix.filter((segment) => visibleTokenMixKeys.has(segment.key));
  const tokenMixTotal = visibleTokenMix.reduce((acc, s) => acc + s.tokens, 0);
  const displayTotalTokens = todayTotalTokens ?? tokenMixTotal;
  const hasTokenMixData = visibleTokenMix.some((segment) => segment.tokens > 0);
  const rankedTokenMix = [...visibleTokenMix].sort((left, right) => right.tokens - left.tokens);
  const maxTokenMixTokens = rankedTokenMix.reduce((max, segment) => Math.max(max, segment.tokens), 0);
  const trafficAxisTickIndexes = buildTrafficAxisTickIndexes(visibleTimeline.length);
  const trafficGridStyle = { '--bucket-count': Math.max(visibleTimeline.length, 1) } as TrafficGridStyle;
  const callsLinePath = buildCallsLinePath(visibleTimeline);
  const healthPoints = todayRequestHealthTimeline?.points ?? [];
  const healthBucketMs = todayRequestHealthTimeline?.bucket_ms || fallbackHealthBucketMs;
  const healthRowsPerHour = Math.max(1, Math.round((60 * 60 * 1000) / healthBucketMs));
  const healthRows = healthPoints.length
    ? Array.from({ length: healthRowsPerHour }, (_, minuteIndex) =>
        Array.from({ length: 24 }, (_, hourIndex) => healthPoints[hourIndex * healthRowsPerHour + minuteIndex])
      )
    : [];
  const hourLabelIndexes = [0, 6, 12, 18, 23];

  return (
    <div className={styles.chartsGrid}>
      {/* 1. 流量趋势 */}
      <section className={`${styles.chartCard} ${styles.activityCard}`}>
        <div className={styles.cardHeader}>
          <h3>{t('dashboard.traffic_trend_today')}</h3>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.dot} style={{ background: '#3b82f6' }} />{' '}
              {t('dashboard.traffic_calls')}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.dot} style={{ background: '#10b981' }} />{' '}
              {t('dashboard.traffic_tokens')}
            </span>
          </div>
        </div>
        <div className={styles.trafficChart}>
          <div className={styles.trafficPlot}>
            <div className={styles.trafficGridLines} aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => <span key={index} />)}
            </div>
            <div className={styles.trafficBars} style={trafficGridStyle}>
              {visibleTimeline.map((point) => {
                const share = getTrafficMetricShare(point, 'tokens');
                return (
                  <div
                    key={point.bucket_ms}
                    className={`${styles.trafficBucket} ${
                      isCurrentTrafficBucket(point, trafficNowMs) ? styles.trafficBucketPartial : ''
                    }`}
                    title={`${formatHour(point.bucket_ms, i18n.language)} · ${t('dashboard.traffic_calls')}: ${formatCompactNumber(point.calls)} · ${t('dashboard.traffic_tokens')}: ${formatCompactNumber(point.tokens)}`}
                  >
                    <div
                      className={`${styles.trafficBar} ${styles.tokensBar}`}
                      style={
                        {
                          '--metric-share': share,
                          '--metric-min-height': share > 0 ? '2px' : '0px',
                        } as TrafficBarStyle
                      }
                    />
                  </div>
                );
              })}
            </div>
            {hasData ? (
              <svg className={styles.callsLineLayer} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <path d={callsLinePath} />
              </svg>
            ) : null}
            <div className={styles.trafficYAxis} aria-hidden="true">
              <span>{t('dashboard.traffic_tokens')}</span>
              <span>{t('dashboard.traffic_calls')}</span>
            </div>
            {!hasData && !loading && (
              <div className={styles.empty}>{t('dashboard.no_traffic_data')}</div>
            )}
            {loading && !hasData && <div className={styles.empty}>...</div>}
          </div>
          <div className={styles.trafficAxis} style={trafficGridStyle}>
            {trafficAxisTickIndexes.map((index) => {
              const point = visibleTimeline[index];
              return point ? (
                <span key={point.bucket_ms} style={{ gridColumn: index + 1 }}>
                  {formatHour(point.bucket_ms, i18n.language)}
                </span>
              ) : null;
            })}
          </div>
        </div>
      </section>

      {/* 2. 请求健康时间线 */}
      <section className={`${styles.chartCard} ${styles.healthTimelineCard}`}>
        <div className={`${styles.cardHeader} ${styles.healthHeader}`}>
          <div className={styles.healthTitle}>
            <h3>{t('dashboard.request_health_timeline')}</h3>
            <p>{t('dashboard.request_health_timeline_desc')}</p>
          </div>
          <div className={styles.healthSummary}>
            <strong>{todayRequestHealthTimeline ? formatPercent(todayRequestHealthTimeline.success_rate) : '-'}</strong>
            <div className={styles.healthCounts}>
              <span>
                <i className={styles.healthGood} />{' '}
                {formatCompactNumber(todayRequestHealthTimeline?.success_calls ?? 0)}
              </span>
              <span>
                <i className={styles.healthBad} />{' '}
                {formatCompactNumber(todayRequestHealthTimeline?.failure_calls ?? 0)}
              </span>
            </div>
          </div>
        </div>
        <div className={styles.healthMatrix}>
          {healthRows.length > 0 ? (
            <div className={styles.healthHourAxis}>
              {hourLabelIndexes.map((index) => {
                const point = healthRows[0]?.[index];
                return (
                  <span key={index} style={{ gridColumn: index + 2 }}>
                    {point ? formatHour(point.bucket_ms, i18n.language).slice(0, 2) : '--'}
                  </span>
                );
              })}
            </div>
          ) : null}
          {healthRows.map((row, minuteIndex) => (
            <div key={minuteIndex} className={styles.healthDayRow}>
              <span className={styles.healthDayLabel}>
                {formatMinuteLabel(row[0]?.bucket_ms, i18n.language)}
              </span>
              <div className={styles.healthDayCells}>
                {row.map((point, hourIndex) =>
                  point ? (
                    <div
                      key={point.bucket_ms}
                      className={`${styles.healthCell} ${styles[healthToneClassMap[point.tone] ?? 'healthEmpty']}`}
                      style={{ '--cell-intensity': point.intensity } as HealthCellStyle}
                      title={buildHealthTitle(point, i18n.language, t)}
                    />
                  ) : (
                    <div
                      key={`${minuteIndex}-${hourIndex}`}
                      className={`${styles.healthCell} ${styles.healthFuture}`}
                    />
                  )
                )}
              </div>
            </div>
          ))}
          {healthPoints.length === 0 && !loading ? (
            <div className={styles.healthEmptyState}>{t('dashboard.request_health_no_data')}</div>
          ) : null}
          {healthPoints.length === 0 && loading ? (
            <div className={styles.healthEmptyState}>...</div>
          ) : null}
        </div>
        <div className={styles.healthLegend}>
          <span><i className={styles.healthEmpty} /> {t('dashboard.request_health_no_request')}</span>
          <span><i className={styles.healthGood} /> {t('dashboard.request_health_success')}</span>
          <span><i className={styles.healthWarn} /> {t('dashboard.request_health_warning')}</span>
          <span><i className={styles.healthBad} /> {t('dashboard.request_health_failure')}</span>
          <span><i className={styles.healthFuture} /> {t('dashboard.request_health_future')}</span>
        </div>
      </section>

      {/* 3. Token 构成 */}
      <section className={`${styles.chartCard} ${styles.tokenCard}`}>
        <div className={styles.cardHeader}>
          <h3>{t('dashboard.token_mix_today')}</h3>
        </div>
        <div className={styles.tokenRankSection}>
          <div className={styles.tokenSummary}>
            <span>{t('dashboard.total_tokens')}</span>
            <strong>{loading && !hasTokenMixData ? '...' : formatCompactNumber(displayTotalTokens)}</strong>
          </div>
          {hasTokenMixData ? (
            <div className={styles.tokenRankList}>
              {rankedTokenMix.map((segment) => (
                <button
                  type="button"
                  key={segment.key}
                  className={`${styles.tokenRankRow} ${
                    activeTokenSegment?.key === segment.key ? styles.tokenRankRowActive : ''
                  }`}
                  onMouseEnter={() => setActiveTokenSegment(segment)}
                  onMouseLeave={() => setActiveTokenSegment(null)}
                  onFocus={() => setActiveTokenSegment(segment)}
                  onBlur={() => setActiveTokenSegment(null)}
                  aria-label={`${t(tokenLabelMap[segment.key] || segment.key)} ${formatCompactNumber(segment.tokens)} ${(segment.share * 100).toFixed(1)}%`}
                >
                  <span className={styles.tokenRankHeader}>
                    <span className={styles.tokenRankIdentity}>
                      <i
                        className={styles.tokenRankSwatch}
                        style={{ background: tokenColorMap[segment.key] || '#ccc' }}
                        aria-hidden="true"
                      />
                      <span>{t(tokenLabelMap[segment.key] || segment.key)}</span>
                    </span>
                    <span className={styles.tokenRankMeta}>
                      <strong>{formatCompactNumber(segment.tokens)}</strong>
                      <span>{(segment.share * 100).toFixed(1)}%</span>
                    </span>
                  </span>
                  <span className={styles.tokenRankTrack}>
                    <span
                      className={styles.tokenRankBar}
                      style={
                        {
                          '--rank-share': maxTokenMixTokens > 0 ? segment.tokens / maxTokenMixTokens : 0,
                          '--rank-color': tokenColorMap[segment.key] || '#ccc',
                        } as TokenRankStyle
                      }
                    />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.tokenEmptyState}>
              {loading ? '...' : t('dashboard.no_token_mix_data')}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
