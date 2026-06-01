import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  apiClient: {
    get: mocks.get,
    put: mocks.put,
  },
}));

import { providersApi } from './providers';

beforeEach(() => {
  mocks.get.mockReset();
  mocks.put.mockReset();
});

describe('providersApi auth-index preservation', () => {
  it('serializes auth-index-only provider keys and preserves unknown raw fields', async () => {
    mocks.get.mockResolvedValue({
      'codex-api-key': [
        {
          'auth-index': 'auth-1',
          'api-key': 'old-key',
          'base-url': 'https://old.example.com/v1',
          'raw-field': 'keep',
          models: [{ name: 'old-model', 'raw-model-field': true }],
        },
      ],
    });
    mocks.put.mockResolvedValue({});

    await providersApi.saveCodexConfigs([
      {
        apiKey: '',
        authIndex: 'auth-1',
        baseUrl: 'https://new.example.com/v1',
        models: [{ name: 'new-model', alias: 'alias' }],
      },
    ]);

    expect(mocks.put).toHaveBeenCalledWith('/codex-api-key', [
      {
        'raw-field': 'keep',
        'auth-index': 'auth-1',
        'base-url': 'https://new.example.com/v1',
        models: [{ name: 'new-model', alias: 'alias', 'raw-model-field': true }],
      },
    ]);
  });

  it('serializes OpenAI auth-index entries and preserves raw provider fields', async () => {
    mocks.get.mockResolvedValue({
      'openai-compatibility': [
        {
          name: 'openai-compatible',
          'base-url': 'https://api.example.com/v1',
          'api-key-entries': [
            {
              'auth-index': 'auth-2',
              'api-key': 'old-key',
              'raw-entry-field': 'keep-entry',
            },
          ],
          'raw-provider-field': 'keep-provider',
        },
      ],
    });
    mocks.put.mockResolvedValue({});

    await providersApi.saveOpenAIProviders([
      {
        name: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEntries: [{ apiKey: '', authIndex: 'auth-2' }],
      },
    ]);

    expect(mocks.put).toHaveBeenCalledWith('/openai-compatibility', [
      {
        'raw-provider-field': 'keep-provider',
        name: 'openai-compatible',
        'base-url': 'https://api.example.com/v1',
        'api-key-entries': [{ 'raw-entry-field': 'keep-entry', 'auth-index': 'auth-2' }],
      },
    ]);
  });

  it('falls back to serialized payload when raw config loading fails', async () => {
    mocks.get.mockRejectedValue(new Error('forbidden'));
    mocks.put.mockResolvedValue({});

    await providersApi.saveGeminiKeys([{ apiKey: '', authIndex: 'auth-3' }]);

    expect(mocks.put).toHaveBeenCalledWith('/gemini-api-key', [{ 'auth-index': 'auth-3' }]);
  });
});
