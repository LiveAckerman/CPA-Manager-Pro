import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Select, type SelectOption } from '@/components/ui/Select';
import { apiCallApi } from '@/services/api/apiCall';

import styles from './ProviderTestModal.module.css';
import {
  buildTestRequest,
  classifyResult,
  PROVIDER_TEST_PROMPT,
  PROVIDER_TEST_TIMEOUT_MS,
  type ProviderKind,
} from './providerTest';

export interface ProviderTestAuthOption {
  label: string;
  baseUrl?: string;
  apiKey?: string;
  authIndex?: string;
  headers?: Record<string, string>;
}

export interface ProviderTestModalProps {
  open: boolean;
  onClose: () => void;
  kind: ProviderKind;
  /** Provider display name shown in the header card. */
  providerLabel: string;
  /** Small uppercase tag, e.g. "OPENAI" / "OAUTH". */
  badge?: string;
  /** Model names offered in the dropdown. */
  models: string[];
  /** Preferred default model (provider testModel). */
  defaultModel?: string;
  /** One entry per testable credential (OpenAI providers have many keys). */
  authOptions: ProviderTestAuthOption[];
}

type LineKind = 'req' | 'ok' | 'err' | 'info' | 'reply';
interface OutputLine {
  kind: LineKind;
  text: string;
}

const isTimeoutError = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const code = 'code' in err ? String((err as { code?: unknown }).code) : '';
  const message = 'message' in err ? String((err as { message?: unknown }).message) : '';
  return code === 'ECONNABORTED' || message.toLowerCase().includes('timeout');
};

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
};

export function ProviderTestModal({
  open,
  onClose,
  kind,
  providerLabel,
  badge,
  models,
  defaultModel,
  authOptions,
}: ProviderTestModalProps) {
  const { t } = useTranslation();

  const modelOptions: SelectOption[] = useMemo(
    () => Array.from(new Set(models.filter(Boolean))).map((m) => ({ value: m, label: m })),
    [models]
  );
  const hasModelOptions = modelOptions.length > 0;

  const [model, setModel] = useState('');
  const [authIdx, setAuthIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const runIdRef = useRef(0);

  // Reset selections each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const preferred = (defaultModel ?? '').trim();
    setModel(preferred || models.find(Boolean) || '');
    setAuthIdx(0);
    setLines([]);
    setRunning(false);
  }, [open, defaultModel, models]);

  const authSelectOptions: SelectOption[] = useMemo(
    () => authOptions.map((opt, i) => ({ value: String(i), label: opt.label })),
    [authOptions]
  );

  const runTest = async () => {
    if (running) return;
    const modelName = model.trim();
    if (!modelName) {
      setLines([{ kind: 'err', text: t('ai_providers.provider_test_no_model') }]);
      return;
    }
    const auth = authOptions[authIdx] ?? authOptions[0];
    if (!auth) {
      setLines([{ kind: 'err', text: t('ai_providers.provider_test_no_auth') }]);
      return;
    }

    const built = buildTestRequest(kind, auth, modelName);
    if ('unsupported' in built) {
      const reasonKey =
        built.reason === 'unsaved'
          ? 'ai_providers.provider_test_unsupported_unsaved'
          : 'ai_providers.provider_test_unsupported_endpoint';
      setLines([{ kind: 'err', text: t(reasonKey) }]);
      return;
    }

    const runId = ++runIdRef.current;
    setRunning(true);
    setLines([
      { kind: 'req', text: `→ ${built.request.method} ${built.request.url}` },
      { kind: 'info', text: t('ai_providers.provider_test_running') },
    ]);

    try {
      const result = await apiCallApi.request(built.request, { timeout: PROVIDER_TEST_TIMEOUT_MS });
      if (runId !== runIdRef.current) return;
      const outcome = classifyResult(result, built.expectText);
      const next: OutputLine[] = [{ kind: 'req', text: `→ ${built.request.method} ${built.request.url}` }];
      if (outcome.status === 'success') {
        next.push({ kind: 'ok', text: `✓ HTTP ${outcome.httpStatus} · ${t('ai_providers.provider_test_success')}` });
        // Show only the assistant reply, not the raw JSON.
        if (outcome.detail) next.push({ kind: 'reply', text: outcome.detail });
      } else {
        const kindKey: Record<string, string> = {
          unauthorized: 'ai_providers.provider_test_unauthorized',
          rate_limited: 'ai_providers.provider_test_rate_limited',
          upstream_error: 'ai_providers.provider_test_upstream_error',
          bad_response: 'ai_providers.provider_test_bad_response',
          failed: 'ai_providers.provider_test_failed',
        };
        next.push({
          kind: 'err',
          text: `✗ HTTP ${outcome.httpStatus || '-'} · ${t(kindKey[outcome.kind])}`,
        });
        // 'html'/'no-reply' are internal codes for bad_response — don't echo them.
        if (outcome.kind !== 'bad_response' && outcome.error) {
          next.push({ kind: 'err', text: outcome.error });
        }
        // For failures, a short raw-body snippet helps diagnose.
        if (outcome.detail) next.push({ kind: 'info', text: outcome.detail });
      }
      setLines(next);
    } catch (err: unknown) {
      if (runId !== runIdRef.current) return;
      const message = isTimeoutError(err)
        ? t('ai_providers.provider_test_timeout', { seconds: PROVIDER_TEST_TIMEOUT_MS / 1000 })
        : errorMessage(err) || t('common.unknown_error');
      setLines([{ kind: 'err', text: `✗ ${message}` }]);
    } finally {
      if (runId === runIdRef.current) setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('ai_providers.provider_test_title')}
      width={640}
      closeDisabled={running}
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={running}>
            {t('ai_providers.provider_test_close')}
          </Button>
          <Button size="sm" onClick={() => void runTest()} loading={running} disabled={running}>
            {t('ai_providers.provider_test_start')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.providerCard}>
          <div className={styles.providerName}>{providerLabel}</div>
          {badge && <span className={styles.badge}>{badge}</span>}
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('ai_providers.provider_test_model_label')}</label>
          {hasModelOptions ? (
            <Select
              value={model}
              options={modelOptions}
              onChange={setModel}
              ariaLabel={t('ai_providers.provider_test_model_label')}
              placeholder={t('ai_providers.provider_test_model_placeholder')}
            />
          ) : (
            <input
              className={styles.modelInput}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('ai_providers.provider_test_model_placeholder')}
            />
          )}
        </div>

        {authSelectOptions.length > 1 && (
          <div className={styles.field}>
            <label className={styles.label}>{t('ai_providers.provider_test_key_label')}</label>
            <Select
              value={String(authIdx)}
              options={authSelectOptions}
              onChange={(v) => setAuthIdx(Number(v))}
              ariaLabel={t('ai_providers.provider_test_key_label')}
            />
          </div>
        )}

        <div className={styles.output}>
          {lines.length === 0 ? (
            <div className={styles.placeholder}>{t('ai_providers.provider_test_idle')}</div>
          ) : (
            lines.map((line, i) => (
              <pre key={i} className={`${styles.line} ${styles[`line_${line.kind}`]}`}>
                {line.text}
              </pre>
            ))
          )}
        </div>

        <div className={styles.hint}>
          {t('ai_providers.provider_test_prompt_hint', { prompt: PROVIDER_TEST_PROMPT })}
        </div>
      </div>
    </Modal>
  );
}
