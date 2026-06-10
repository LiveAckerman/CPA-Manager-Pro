import { describe, expect, it } from 'vitest';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import {
  authFileMatchesCodexPlanFilter,
  authFileMatchesCodexStatusFilter,
  buildAuthFileCodexInspectionMap,
  getAuthFileCodexInspectionKey,
  getAuthFileCodexStatus,
  getAuthFileNameFromSelectionKey,
  getAuthFilePatchTarget,
  getAuthFileSearchValues,
  getAuthFileSelectionKey,
  hasPartialSharedAuthFileSelection,
  normalizeAuthFilesCodexStatusFilter,
  stringifySearchValue,
  type AuthFileCodexInspectionSnapshot,
} from './authFilesPageModel';

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as never;

const codexFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'codex-main.json',
  type: 'codex',
  authIndex: 'codex-main',
  ...overrides,
});

const codexQuota = (overrides: Partial<CodexQuotaState> = {}): CodexQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour limit',
      usedPercent: 10,
      resetLabel: '06/01 17:00',
      limitWindowSeconds: 18_000,
    },
    {
      id: 'weekly',
      label: 'Weekly limit',
      usedPercent: 100,
      resetLabel: '06/04 12:00',
      limitWindowSeconds: 604_800,
    },
  ],
  ...overrides,
});

describe('auth file Codex status helpers', () => {
  it('detects weekly-limited Codex quota from the weekly quota window', () => {
    const status = getAuthFileCodexStatus(codexFile(), codexQuota());

    expect(status.isCodex).toBe(true);
    expect(status.isWeeklyLimited).toBe(true);
    expect(authFileMatchesCodexStatusFilter(status, 'weekly_limited')).toBe(true);
    expect(status.badges.map((badge) => badge.kind)).toContain('weekly_limited');
  });

  it('detects five-hour limited Codex quota from the short quota window', () => {
    const status = getAuthFileCodexStatus(
      codexFile(),
      codexQuota({
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 100,
            resetLabel: '06/01 17:00',
            limitWindowSeconds: 18_000,
          },
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: 45,
            resetLabel: '06/04 12:00',
            limitWindowSeconds: 604_800,
          },
        ],
      })
    );

    expect(status.isFiveHourLimited).toBe(true);
    expect(status.isWeeklyLimited).toBe(false);
    expect(status.fiveHourResetLabel).toBe('06/01 17:00');
    expect(authFileMatchesCodexStatusFilter(status, 'five_hour_limited')).toBe(true);
    expect(authFileMatchesCodexStatusFilter(status, 'weekly_limited')).toBe(false);
    expect(status.badges.map((badge) => badge.kind)).toContain('five_hour_limited');
  });

  it('detects monthly-limited Codex quota without treating it as weekly-limited', () => {
    const status = getAuthFileCodexStatus(
      codexFile(),
      codexQuota({
        windows: [
          {
            id: 'monthly',
            label: 'Monthly limit',
            usedPercent: 100,
            resetLabel: '06/30 12:00',
            limitWindowSeconds: 2_592_000,
          },
        ],
      })
    );

    expect(status.isMonthlyLimited).toBe(true);
    expect(status.isWeeklyLimited).toBe(false);
    expect(status.monthlyResetLabel).toBe('06/30 12:00');
    expect(authFileMatchesCodexStatusFilter(status, 'monthly_limited')).toBe(true);
    expect(authFileMatchesCodexStatusFilter(status, 'weekly_limited')).toBe(false);
    expect(status.badges.map((badge) => badge.kind)).toContain('monthly_limited');
  });

  it('detects disabled Codex files with a known quota recovery label', () => {
    const status = getAuthFileCodexStatus(codexFile({ disabled: true }), codexQuota());

    expect(status.hasDisabledRecoveryReset).toBe(true);
    expect(status.weeklyResetLabel).toBe('06/04 12:00');
    expect(status.recoveryResetLabel).toBe('06/04 12:00');
    expect(authFileMatchesCodexStatusFilter(status, 'disabled_with_reset')).toBe(true);
    expect(status.badges.find((badge) => badge.kind === 'disabled_with_reset')).toMatchObject({
      labelParams: { reset: '06/04 12:00' },
    });
  });

  it('uses the five-hour reset label for disabled files when only the short window is full', () => {
    const status = getAuthFileCodexStatus(
      codexFile({ disabled: true }),
      codexQuota({
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 100,
            resetLabel: '06/01 17:00',
            limitWindowSeconds: 18_000,
          },
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: 45,
            resetLabel: '06/04 12:00',
            limitWindowSeconds: 604_800,
          },
        ],
      })
    );

    expect(status.hasDisabledRecoveryReset).toBe(true);
    expect(status.recoveryResetLabel).toBe('06/01 17:00');
    expect(status.badges.find((badge) => badge.kind === 'disabled_with_reset')).toMatchObject({
      labelParams: { reset: '06/01 17:00' },
    });
  });

  it('uses the monthly reset label for disabled files when the monthly window is full', () => {
    const status = getAuthFileCodexStatus(
      codexFile({ disabled: true }),
      codexQuota({
        windows: [
          {
            id: 'monthly',
            label: 'Monthly limit',
            usedPercent: 100,
            resetLabel: '06/30 12:00',
            limitWindowSeconds: 2_592_000,
          },
        ],
      })
    );

    expect(status.hasDisabledRecoveryReset).toBe(true);
    expect(status.recoveryResetLabel).toBe('06/30 12:00');
    expect(status.badges.find((badge) => badge.kind === 'disabled_with_reset')).toMatchObject({
      labelParams: { reset: '06/30 12:00' },
    });
  });

  it('does not mark manually disabled Codex files as waiting recovery when quota is available', () => {
    const status = getAuthFileCodexStatus(
      codexFile({ disabled: true }),
      codexQuota({
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 10,
            resetLabel: '06/01 17:00',
            limitWindowSeconds: 18_000,
          },
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: 45,
            resetLabel: '06/04 12:00',
            limitWindowSeconds: 604_800,
          },
        ],
      })
    );

    expect(status.hasDisabledRecoveryReset).toBe(false);
    expect(authFileMatchesCodexStatusFilter(status, 'disabled_with_reset')).toBe(false);
  });

  it('detects HTTP 401 and reauth needs from the latest inspection result', () => {
    const status = getAuthFileCodexStatus(codexFile(), undefined, {
      fileName: 'codex-main.json',
      authIndex: 'codex-main',
      statusCode: 401,
      action: 'reauth',
      usedPercent: null,
      isQuota: false,
    });

    expect(status.isHttp401).toBe(true);
    expect(status.needsReauth).toBe(true);
    expect(authFileMatchesCodexStatusFilter(status, 'http_401')).toBe(true);
    expect(authFileMatchesCodexStatusFilter(status, 'reauth')).toBe(true);
    expect(status.badges.map((badge) => badge.kind)).toContain('reauth');
  });

  it('does not treat non-quota inspection percentages as weekly quota limits', () => {
    const status = getAuthFileCodexStatus(codexFile(), undefined, {
      fileName: 'codex-main.json',
      authIndex: 'codex-main',
      statusCode: 401,
      action: 'delete',
      usedPercent: 100,
      isQuota: false,
    });

    expect(status.isHttp401).toBe(true);
    expect(status.isWeeklyLimited).toBe(false);
    expect(authFileMatchesCodexStatusFilter(status, 'weekly_limited')).toBe(false);
  });

  it('does not mark legacy quota inspections as monthly-limited without a monthly window', () => {
    const status = getAuthFileCodexStatus(codexFile(), undefined, {
      fileName: 'codex-main.json',
      authIndex: 'codex-main',
      statusCode: 402,
      action: 'disable',
      usedPercent: 100,
      isQuota: true,
    });

    expect(status.isWeeklyLimited).toBe(true);
    expect(status.isMonthlyLimited).toBe(false);
    expect(authFileMatchesCodexStatusFilter(status, 'weekly_limited')).toBe(true);
    expect(authFileMatchesCodexStatusFilter(status, 'monthly_limited')).toBe(false);
  });

  it('ignores non-Codex files for Codex-only status filters', () => {
    const status = getAuthFileCodexStatus({ name: 'qwen.json', type: 'qwen' }, codexQuota());

    expect(status.isCodex).toBe(false);
    expect(status.isWeeklyLimited).toBe(false);
    expect(authFileMatchesCodexStatusFilter(status, 'weekly_limited')).toBe(false);
  });

  it('indexes inspection results by file name and auth index', () => {
    const inspection: AuthFileCodexInspectionSnapshot = {
      fileName: 'codex-main.json',
      authIndex: 'codex-main',
      statusCode: 401,
      action: 'delete',
      usedPercent: null,
      isQuota: false,
    };

    const map = buildAuthFileCodexInspectionMap([inspection]);

    expect(map.get(getAuthFileCodexInspectionKey('codex-main.json', 'codex-main'))).toBe(
      inspection
    );
  });

  it('adds derived Codex status labels to searchable values', () => {
    const status = getAuthFileCodexStatus(codexFile(), undefined, {
      fileName: 'codex-main.json',
      authIndex: 'codex-main',
      statusCode: 401,
      action: 'reauth',
      usedPercent: null,
      isQuota: false,
    });

    expect(
      stringifySearchValue(getAuthFileSearchValues(codexFile(), t, undefined, status))
    ).toContain('auth_files.codex_status_badge_reauth');
    expect(normalizeAuthFilesCodexStatusFilter('http_401')).toBe('reauth');
    expect(normalizeAuthFilesCodexStatusFilter('five_hour_limited')).toBe('five_hour_limited');
    expect(normalizeAuthFilesCodexStatusFilter('monthly_limited')).toBe('monthly_limited');
    expect(normalizeAuthFilesCodexStatusFilter('disabled_with_reset')).toBe('disabled_with_reset');
    expect(normalizeAuthFilesCodexStatusFilter('unknown')).toBeNull();
  });
});

describe('auth file Codex plan helpers', () => {
  it('matches Codex files by plan from file metadata or quota fallback', () => {
    expect(
      authFileMatchesCodexPlanFilter(codexFile({ plan_type: 'plus' }), undefined, 'plus')
    ).toBe(true);
    expect(
      authFileMatchesCodexPlanFilter(codexFile({ plan_type: 'plus' }), undefined, 'team')
    ).toBe(false);
    expect(
      authFileMatchesCodexPlanFilter(
        codexFile({ metadata: { planType: 'pro-lite' } }),
        undefined,
        'prolite'
      )
    ).toBe(true);
    expect(
      authFileMatchesCodexPlanFilter(
        codexFile({ name: 'quota-team.json' }),
        codexQuota({ planType: 'team' }),
        'team'
      )
    ).toBe(true);
    expect(authFileMatchesCodexPlanFilter(codexFile(), undefined, 'unknown')).toBe(true);
    expect(
      authFileMatchesCodexPlanFilter({ name: 'qwen.json', type: 'qwen' }, undefined, 'plus')
    ).toBe(false);
  });

  it('keeps same-file auth rows distinct for selection and patch targets', () => {
    const first = codexFile({ name: 'shared-codex.json', authIndex: 0 });
    const second = codexFile({ name: 'shared-codex.json', authIndex: 1 });
    const firstKey = getAuthFileSelectionKey(first);
    const secondKey = getAuthFileSelectionKey(second);

    expect(firstKey).not.toBe(secondKey);
    expect(getAuthFileNameFromSelectionKey(firstKey)).toBe('shared-codex.json');
    expect(getAuthFilePatchTarget(first)).toEqual({ name: 'shared-codex.json', authIndex: 0 });
    expect(getAuthFilePatchTarget(codexFile({ authIndex: undefined }))).toEqual({
      name: 'codex-main.json',
    });
  });

  it('detects partial selection for shared auth files', () => {
    const first = codexFile({ name: 'shared-codex.json', authIndex: 0 });
    const second = codexFile({ name: 'shared-codex.json', authIndex: 1 });
    const single = codexFile({ name: 'single-codex.json', authIndex: 'single' });

    expect(
      hasPartialSharedAuthFileSelection([first, second, single], [getAuthFileSelectionKey(first)])
    ).toBe(true);
    expect(
      hasPartialSharedAuthFileSelection(
        [first, second, single],
        [first, second].map(getAuthFileSelectionKey)
      )
    ).toBe(false);
    expect(
      hasPartialSharedAuthFileSelection([first, second, single], [getAuthFileSelectionKey(single)])
    ).toBe(false);
  });
});
