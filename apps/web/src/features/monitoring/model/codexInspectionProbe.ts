import type { AxiosRequestConfig } from 'axios';
import { requestCodexUsageRaw } from '@/services/api/codexQuota';
import type { AuthFileItem, CodexRateLimitInfo } from '@/types';
import {
  classifyCodexRateLimitWindows,
  deriveCodexRateLimitUsedPercent,
  getCodexQuotaWindowUsedPercent,
  isCodexRateLimitReached,
  isDisabledAuthFile,
  resolveAuthProvider,
  resolveCodexChatgptAccountId,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/usage';
import {
  type CodexInspectionAccount,
  type CodexInspectionLogLevel,
  type CodexInspectionResultItem,
  type CodexInspectionSettings,
} from '@/features/monitoring/codexInspection';
import { readString } from './codexInspectionSettings';

type LogHandler = (level: CodexInspectionLogLevel, message: string) => void;

const QUOTA_BODY_PATTERNS = ['quota exhausted', 'limit reached', 'payment_required'];

const readAuthFileName = (file: AuthFileItem) => {
  const name = readString(file.name);
  if (name) return name;
  const id = readString(file.id);
  if (id) return id;
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  return authIndex || 'unknown-auth-file';
};

const readDisplayAccount = (file: AuthFileItem) =>
  readString(file.account) ||
  readString(file.email) ||
  readString(file.label) ||
  readString(file.name) ||
  readString(file.id) ||
  normalizeAuthIndex(file['auth_index'] ?? file.authIndex) ||
  '-';

export const toInspectionAccount = (file: AuthFileItem): CodexInspectionAccount => ({
  key: `${readAuthFileName(file)}::${normalizeAuthIndex(file['auth_index'] ?? file.authIndex) || '-'}`,
  fileName: readAuthFileName(file),
  displayAccount: readDisplayAccount(file),
  authIndex: normalizeAuthIndex(file['auth_index'] ?? file.authIndex),
  accountId: resolveCodexChatgptAccountId(file),
  provider: resolveAuthProvider(file),
  disabled: isDisabledAuthFile(file),
  status: readString(file.status),
  state: readString(file.state),
  raw: file,
});

const withRetry = async <T>(retries: number, task: () => Promise<T>): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

type CodexInspectionDecision = Pick<
  CodexInspectionResultItem,
  'action' | 'actionReason' | 'usedPercent' | 'isQuota'
>;

type UnauthorizedReason = 'unknown' | 'expired' | 'invalidated';

const classifyUnauthorizedReason = (bodyText: string): UnauthorizedReason => {
  const normalized = bodyText.trim().toLowerCase();
  if (
    normalized.includes('provided authentication token is expired') ||
    normalized.includes('authentication token is expired') ||
    normalized.includes('token is expired')
  ) {
    return 'expired';
  }
  if (
    normalized.includes('authentication token has been invalidated') ||
    normalized.includes('token has been invalidated') ||
    normalized.includes('token is invalidated')
  ) {
    return 'invalidated';
  }
  return 'unknown';
};

const resolveUnauthorizedProbeAction = (
  bodyText: string,
  usedPercent: number | null
): CodexInspectionDecision => {
  switch (classifyUnauthorizedReason(bodyText)) {
    case 'expired':
      return {
        action: 'reauth',
        actionReason: '接口返回 401，登录已过期，建议重新登录账号',
        usedPercent,
        isQuota: false,
      };
    case 'invalidated':
      return {
        action: 'delete',
        actionReason: '接口返回 401，认证令牌已失效，建议删除账号',
        usedPercent,
        isQuota: false,
      };
    default:
      return {
        action: 'delete',
        actionReason: '接口返回 401，建议删除失效账号',
        usedPercent,
        isQuota: false,
      };
  }
};

const resolveLegacyProbeAction = (
  account: CodexInspectionAccount,
  statusCode: number,
  bodyText: string,
  usedPercent: number | null,
  isQuota: boolean,
  threshold: number
): CodexInspectionDecision => {
  const overThreshold = usedPercent !== null && usedPercent >= threshold;
  if (statusCode === 401) {
    return resolveUnauthorizedProbeAction(bodyText, usedPercent);
  }
  if (isQuota || overThreshold) {
    if (account.disabled) {
      return {
        action: 'keep',
        actionReason: overThreshold ? '额度超阈值，但账号已禁用' : '额度已耗尽，但账号已禁用',
        usedPercent,
        isQuota,
      };
    }
    return {
      action: 'disable',
      actionReason: overThreshold ? '额度超阈值，建议禁用账号' : '额度已耗尽，建议禁用账号',
      usedPercent,
      isQuota,
    };
  }
  if (statusCode === 200 && account.disabled) {
    return {
      action: 'enable',
      actionReason: '账号恢复健康，建议重新启用',
      usedPercent,
      isQuota: false,
    };
  }
  return {
    action: 'keep',
    actionReason: '无需处理',
    usedPercent,
    isQuota: false,
  };
};

const resolveWindowAwareProbeAction = (
  account: CodexInspectionAccount,
  statusCode: number,
  bodyText: string,
  rateLimit: CodexRateLimitInfo | null,
  threshold: number
): CodexInspectionDecision | null => {
  if (!rateLimit) return null;

  const { fiveHourWindow, weeklyWindow } = classifyCodexRateLimitWindows(rateLimit);
  const weeklyUsedPercent = getCodexQuotaWindowUsedPercent(weeklyWindow);
  if (!weeklyWindow || weeklyUsedPercent === null) return null;

  const fiveHourUsedPercent = getCodexQuotaWindowUsedPercent(fiveHourWindow);
  const weeklyOverThreshold = weeklyUsedPercent >= threshold;
  const fiveHourOverThreshold = fiveHourUsedPercent !== null && fiveHourUsedPercent >= threshold;

  if (statusCode === 401) {
    return resolveUnauthorizedProbeAction(bodyText, weeklyUsedPercent);
  }

  if (weeklyOverThreshold) {
    if (account.disabled) {
      return {
        action: 'keep',
        actionReason: '周额度达到阈值，但账号已禁用',
        usedPercent: weeklyUsedPercent,
        isQuota: true,
      };
    }
    return {
      action: 'disable',
      actionReason: '周额度达到阈值，建议禁用账号',
      usedPercent: weeklyUsedPercent,
      isQuota: true,
    };
  }

  if (account.disabled) {
    return {
      action: 'enable',
      actionReason: fiveHourOverThreshold
        ? '5 小时额度达到阈值，但周额度仍可用，建议立即启用账号'
        : '周额度仍可用，建议立即启用账号',
      usedPercent: weeklyUsedPercent,
      isQuota: false,
    };
  }

  if (fiveHourOverThreshold) {
    return {
      action: 'keep',
      actionReason: '5 小时额度达到阈值，但周额度仍可用，暂不禁用账号',
      usedPercent: weeklyUsedPercent,
      isQuota: false,
    };
  }

  return {
    action: 'keep',
    actionReason: '周额度仍可用，无需处理',
    usedPercent: weeklyUsedPercent,
    isQuota: false,
  };
};

const resolveProbeAction = (
  account: CodexInspectionAccount,
  statusCode: number,
  bodyText: string,
  rateLimit: CodexRateLimitInfo | null,
  usedPercent: number | null,
  isQuota: boolean,
  threshold: number
): CodexInspectionDecision => {
  const windowAwareDecision = resolveWindowAwareProbeAction(
    account,
    statusCode,
    bodyText,
    rateLimit,
    threshold
  );
  if (windowAwareDecision) return windowAwareDecision;
  return resolveLegacyProbeAction(account, statusCode, bodyText, usedPercent, isQuota, threshold);
};

export const inspectSingleAccount = async (
  account: CodexInspectionAccount,
  settings: CodexInspectionSettings,
  onLog?: LogHandler
): Promise<CodexInspectionResultItem> => {
  if (!account.authIndex) {
    onLog?.('warning', `${account.displayAccount} 缺少 auth_index，跳过探测`);
    return {
      ...account,
      action: 'keep',
      actionReason: '缺少 auth_index，保留账号',
      statusCode: null,
      usedPercent: null,
      isQuota: false,
      error: '缺少 auth_index',
    };
  }

  const authIndex = account.authIndex;
  const fileName = (account.fileName || '').trim();
  const requestConfig: AxiosRequestConfig =
    settings.timeout > 0 ? { timeout: settings.timeout } : {};

  try {
    const { result, payload } = await withRetry(settings.retries, () =>
      requestCodexUsageRaw({
        authIndex,
        // Passing fileName routes through image-service's safe probe
        // endpoint, which uses the cached access_token directly against
        // ChatGPT — no refresh_token grant fires, so heavy inspection
        // runs no longer get free accounts session_terminated. Falls
        // back to the legacy /api-call path automatically if fileName
        // is empty (defensive — every account from toInspectionAccount
        // should always have fileName).
        fileName: fileName || undefined,
        accountId: account.accountId,
        userAgent: settings.userAgent,
        requestConfig,
      })
    );

    if (!result.hasStatusCode) {
      onLog?.('warning', `${account.displayAccount} 探测未返回 status_code，保留账号`);
      return {
        ...account,
        action: 'keep',
        actionReason: '探测响应缺少 status_code，保留账号',
        statusCode: null,
        usedPercent: null,
        isQuota: false,
        error: '响应缺少 status_code',
      };
    }

    // Safe-path 401 = authoritative "dead token, account likely fine".
    // image-service only returns needs_reauth after it ALREADY re-downloaded
    // a fresh token from CPA and that fresh token ALSO 401'd. For MFA/2FA
    // accounts this is NOT a ban — the account logs in fine at chatgpt.com,
    // it just can't use the OAuth refresh flow. So the right action is
    // `reauth` (re-login in a browser + import the session cookie via the
    // Chrome extension → POST /v0/image/accounts/import-session), NOT delete.
    // Surfacing this as `reauth` keeps these revivable accounts out of the
    // 建议删除 bucket so they don't get batch-deleted by mistake.
    if (result.needsReauth) {
      if (account.disabled) {
        onLog?.(
          'info',
          `${account.displayAccount} -> keep (认证失效，但账号已禁用)`
        );
        return {
          ...account,
          action: 'keep',
          actionReason: '认证已失效（需重新登录），但账号已禁用',
          statusCode: result.statusCode,
          usedPercent: null,
          isQuota: false,
          error: '',
          needsReauth: true,
        };
      }
      onLog?.(
        'warning',
        `${account.displayAccount} -> reauth (HTTP 401 · 认证失效，可浏览器重新登录后导入 cookie 复活)`
      );
      return {
        ...account,
        action: 'reauth',
        actionReason: '认证已失效：CPA 重新下载 token 后仍返回 401。账号未必被封（多为需要二次验证），可在浏览器重新登录后用扩展导入 session cookie 复活，无需删除',
        statusCode: result.statusCode,
        usedPercent: null,
        isQuota: false,
        error: '',
        needsReauth: true,
      };
    }

    const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? null;
    const usedPercent = deriveCodexRateLimitUsedPercent(rateLimit);
    const bodyText = result.bodyText.toLowerCase();
    const isQuota =
      result.statusCode === 402 ||
      QUOTA_BODY_PATTERNS.some((pattern) => bodyText.includes(pattern)) ||
      isCodexRateLimitReached(rateLimit) ||
      (usedPercent !== null && usedPercent >= settings.usedPercentThreshold);
    const decision = resolveProbeAction(
      account,
      result.statusCode,
      result.bodyText,
      rateLimit,
      usedPercent,
      isQuota,
      settings.usedPercentThreshold
    );

    const successLevel =
      decision.action === 'delete'
        ? 'error'
        : decision.action === 'disable'
          ? 'warning'
          : decision.action === 'enable'
            ? 'success'
            : 'info';
    const percentText =
      decision.usedPercent === null ? '--' : `${decision.usedPercent.toFixed(1)}%`;
    onLog?.(
      successLevel,
      `${account.displayAccount} -> ${decision.action} (HTTP ${result.statusCode} · 已用 ${percentText})`
    );

    return {
      ...account,
      action: decision.action,
      actionReason: decision.actionReason,
      statusCode: result.statusCode,
      usedPercent: decision.usedPercent,
      isQuota: decision.isQuota,
      error: '',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || '探测失败');
    onLog?.('warning', `${account.displayAccount} 探测异常，保留账号：${errorMessage}`);
    return {
      ...account,
      action: 'keep',
      actionReason: '探测异常，保留账号',
      statusCode: null,
      usedPercent: null,
      isQuota: false,
      error: errorMessage,
    };
  }
};
