import type { AxiosRequestConfig } from 'axios';
import type { CodexUsagePayload } from '@/types';
import { CODEX_REQUEST_HEADERS, CODEX_USAGE_URL, parseCodexUsagePayload } from '@/utils/quota';
import { apiCallApi, getApiCallErrorMessage, type ApiCallResult } from './apiCall';
import { imageProbeApi } from './imagePool';

export type CodexUsageRequestParams = {
  authIndex: string;
  accountId?: string | null;
  userAgent?: string;
  requestConfig?: AxiosRequestConfig;
  /**
   * When set, the request is routed through image-service's safe probe
   * endpoint instead of CPA's /api-call. The safe path uses image-service's
   * cached access_token directly — no refresh_token grant ever fires — so
   * codex-inspection no longer triggers OpenAI's app_session_terminated on
   * free accounts. Passing fileName is preferred; leave it undefined to
   * fall back to the legacy /api-call path (kept for the rare caller that
   * doesn't have fileName, e.g. one-off CPA-managed probes).
   */
  fileName?: string;
};

export type CodexUsageRawResult = {
  result: ApiCallResult & {
    /**
     * Set by the safe path (imageProbeApi) when ChatGPT returns 401 for
     * the cached access_token. Inspection logic surfaces this as a
     * "needs re-authentication" action instead of treating it as a
     * normal delete-worthy failure.
     */
    needsReauth?: boolean;
  };
  payload: CodexUsagePayload | null;
};

export const buildCodexUsageRequestHeaders = (
  accountId?: string | null,
  options: { userAgent?: string } = {}
): Record<string, string> => {
  const headers: Record<string, string> = {
    ...CODEX_REQUEST_HEADERS,
  };

  const trimmedAccountId = String(accountId ?? '').trim();
  if (trimmedAccountId) {
    headers['Chatgpt-Account-Id'] = trimmedAccountId;
  }

  const userAgent = String(options.userAgent ?? '').trim();
  if (userAgent) {
    headers['User-Agent'] = userAgent;
  }

  return headers;
};

export const requestCodexUsageRaw = async ({
  authIndex,
  accountId,
  userAgent,
  requestConfig,
  fileName,
}: CodexUsageRequestParams): Promise<CodexUsageRawResult> => {
  // Safe path: when the caller knows the CPA file name, route through
  // image-service's probe endpoint so no refresh_token grant fires.
  // codex-inspection (the heaviest caller) supplies fileName since v1;
  // the legacy /api-call path stays for any caller that only has
  // authIndex (e.g. one-off ad-hoc probes from the auth-files page).
  const trimmedFileName = (fileName || '').trim();
  if (trimmedFileName) {
    const probe = await imageProbeApi.probeCodex({
      fileName: trimmedFileName,
      chatgptAccountId: accountId ?? undefined,
      userAgent,
    });
    // Adapt the probe response into the ApiCallResult shape downstream
    // code already consumes, plus surface needsReauth so inspection can
    // classify the account separately from "broken/delete".
    const adapted: CodexUsageRawResult['result'] = {
      statusCode: probe.status_code,
      body: probe.body,
      bodyText: probe.body_text,
      hasStatusCode: probe.has_status_code,
      // Carry the safe-path 401 signal through. Inspection uses this to
      // pick the new 'reauth' action over the legacy 'delete' action.
      needsReauth: probe.needs_reauth,
    } as CodexUsageRawResult['result'];
    return {
      result: adapted,
      payload: parseCodexUsagePayload(probe.body ?? probe.body_text),
    };
  }

  // Legacy path — kept for callers without fileName. Will continue to
  // trigger refresh_token if used heavily, so prefer the safe path.
  const result = await apiCallApi.request(
    {
      authIndex,
      method: 'GET',
      url: CODEX_USAGE_URL,
      header: buildCodexUsageRequestHeaders(accountId, { userAgent }),
    },
    requestConfig
  );

  return {
    result,
    payload: parseCodexUsagePayload(result.body ?? result.bodyText),
  };
};

export const requestCodexUsagePayload = async (
  params: CodexUsageRequestParams,
  options: { emptyMessage?: string } = {}
): Promise<CodexUsagePayload> => {
  const { result, payload } = await requestCodexUsageRaw(params);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(getApiCallErrorMessage(result));
  }
  if (!payload) {
    throw new Error(options.emptyMessage || 'No Codex quota data available');
  }
  return payload;
};
