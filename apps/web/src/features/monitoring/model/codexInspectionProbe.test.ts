import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestCodexUsageRaw } from '@/services/api/codexQuota';
import { DEFAULT_CODEX_INSPECTION_SETTINGS } from './codexInspectionSettings';
import { inspectSingleAccount, toInspectionAccount } from './codexInspectionProbe';

vi.mock('@/services/api/codexQuota', () => ({
  requestCodexUsageRaw: vi.fn(),
}));

const mockRequestCodexUsageRaw = vi.mocked(requestCodexUsageRaw);

const baseAccount = toInspectionAccount({
  name: 'codex-auth.json',
  type: 'codex',
  auth_index: 'auth-1',
  account: 'user@example.test',
});

const settings = {
  baseUrl: '',
  token: '',
  ...DEFAULT_CODEX_INSPECTION_SETTINGS,
  usedPercentThreshold: 100,
};

const createUsageResult = (usedPercent: number, extraWindows = {}) => ({
  result: {
    statusCode: 200,
    hasStatusCode: true,
    header: {},
    bodyText: '',
    body: {},
  },
  payload: {
    user_id: 'user-test',
    account_id: 'acct-test',
    email: 'user@example.test',
    plan_type: 'free',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 2_592_000,
        reset_after_seconds: 2_592_000,
        reset_at: 1_782_895_966,
      },
      secondary_window: null,
      ...extraWindows,
    },
    code_review_rate_limit: null,
    additional_rate_limits: null,
  },
});

describe('inspectSingleAccount', () => {
  beforeEach(() => {
    mockRequestCodexUsageRaw.mockReset();
  });

  it('keeps an enabled account when the monthly Codex quota is still available', async () => {
    mockRequestCodexUsageRaw.mockResolvedValue(createUsageResult(5));

    const result = await inspectSingleAccount(baseAccount, settings);

    expect(result.action).toBe('keep');
    expect(result.actionReason).toBe('月额度仍可用，无需处理');
    expect(result.usedPercent).toBe(5);
    expect(result.isQuota).toBe(false);
  });

  it('disables an enabled account when the monthly Codex quota reaches the threshold', async () => {
    mockRequestCodexUsageRaw.mockResolvedValue(createUsageResult(100));

    const result = await inspectSingleAccount(baseAccount, settings);

    expect(result.action).toBe('disable');
    expect(result.actionReason).toBe('月额度达到阈值，建议禁用账号');
    expect(result.usedPercent).toBe(100);
    expect(result.isQuota).toBe(true);
  });

  it('keeps an enabled account when only the short window is exhausted', async () => {
    mockRequestCodexUsageRaw.mockResolvedValue(
      createUsageResult(5, {
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 5,
          limit_window_seconds: 2_592_000,
        },
      })
    );

    const result = await inspectSingleAccount(baseAccount, settings);

    expect(result.action).toBe('keep');
    expect(result.actionReason).toBe('5 小时额度达到阈值，但月额度仍可用，暂不禁用账号');
    expect(result.usedPercent).toBe(5);
    expect(result.isQuota).toBe(false);
  });

  it('deletes an account when the workspace is deactivated', async () => {
    mockRequestCodexUsageRaw.mockResolvedValue({
      result: {
        statusCode: 402,
        hasStatusCode: true,
        header: {},
        bodyText: '{"detail":{"code":"deactivated_workspace"}}',
        body: { detail: { code: 'deactivated_workspace' } },
      },
      payload: null,
    });

    const result = await inspectSingleAccount(baseAccount, settings);

    expect(result.action).toBe('delete');
    expect(result.actionReason).toBe('接口返回 402，工作区已停用，建议删除账号');
    expect(result.usedPercent).toBe(null);
    expect(result.isQuota).toBe(false);
  });

  it('keeps regular 402 quota responses as disable suggestions', async () => {
    mockRequestCodexUsageRaw.mockResolvedValue({
      result: {
        statusCode: 402,
        hasStatusCode: true,
        header: {},
        bodyText: '{"message":"limit reached"}',
        body: { message: 'limit reached' },
      },
      payload: null,
    });

    const result = await inspectSingleAccount(baseAccount, settings);

    expect(result.action).toBe('disable');
    expect(result.actionReason).toBe('额度已耗尽，建议禁用账号');
    expect(result.isQuota).toBe(true);
  });
});
