import { describe, expect, it } from 'vitest';
import type { ManagerConfig } from '@/services/api/usageService';
import {
  getUsageServiceBootstrapToSync,
  resolveManagerCPAConnection,
  resolveManagerBindingStatus,
  resolveManagerRequestAuthKey,
  resolveManagerSaveState,
  shouldShowMissingManagerAdminKeyError,
} from './ConfigPage';

const buildManagerConfig = (overrides: Partial<ManagerConfig> = {}): ManagerConfig => ({
  cpaConnection: {
    cpaBaseUrl: 'http://cpa.local:8317',
    managementKey: 'management-key',
  },
  collector: {
    enabled: true,
    collectorMode: 'auto',
    queue: 'usage',
    popSide: 'right',
    batchSize: 100,
    pollIntervalMs: 500,
    queryLimit: 50000,
  },
  externalUsageService: {
    enabled: true,
    serviceBase: 'http://manager.local:18317',
  },
  ...overrides,
});

describe('getUsageServiceBootstrapToSync', () => {
  it('returns the normalized service base after a successful auto-load', () => {
    expect(
      getUsageServiceBootstrapToSync({
        serviceBase: 'http://usage.local:18317/',
        usageServiceEnabled: false,
        usageServiceBase: '',
      })
    ).toBe('http://usage.local:18317');
  });

  it('skips syncing when the bootstrap address is already current', () => {
    expect(
      getUsageServiceBootstrapToSync({
        serviceBase: 'http://usage.local:18317/',
        usageServiceEnabled: true,
        usageServiceBase: 'http://usage.local:18317',
      })
    ).toBe('');
  });

  it('skips syncing when the loaded service base is empty', () => {
    expect(
      getUsageServiceBootstrapToSync({
        serviceBase: '   ',
        usageServiceEnabled: false,
        usageServiceBase: '',
      })
    ).toBe('');
  });
});

describe('resolveManagerRequestAuthKey', () => {
  it('uses the login key for same-origin Manager Server panels', () => {
    expect(
      resolveManagerRequestAuthKey({
        panelHostedByUsageService: true,
        managementKey: ' cpa-or-admin-key ',
        managerAdminKey: ' manager-admin-key ',
      })
    ).toBe('cpa-or-admin-key');
  });

  it('prefers the Manager Server admin key for CPA-hosted panels', () => {
    expect(
      resolveManagerRequestAuthKey({
        panelHostedByUsageService: false,
        managementKey: ' cpa-management-key ',
        managerAdminKey: ' manager-admin-key ',
      })
    ).toBe('manager-admin-key');
  });

  it('requires a Manager Server admin key for external panels', () => {
    expect(
      resolveManagerRequestAuthKey({
        panelHostedByUsageService: false,
        managementKey: ' cpa-management-key ',
        managerAdminKey: '   ',
      })
    ).toBe('');
  });
});

describe('resolveManagerCPAConnection', () => {
  it('keeps the saved embedded CPA URL and replaces only the submitted key', () => {
    expect(
      resolveManagerCPAConnection({
        panelHostedByUsageService: true,
        managerConfig: buildManagerConfig({
          cpaConnection: {
            cpaBaseUrl: 'http://saved-cpa.local:8317',
            managementKey: 'old-cpa-key',
          },
        }),
        currentCPAApiBase: 'http://manager.local:18317',
        submittedCPAManagementKey: ' new-cpa-key ',
        externalManagementKey: 'manager-admin-key',
      })
    ).toEqual({
      cpaBaseUrl: 'http://saved-cpa.local:8317',
      managementKey: 'new-cpa-key',
    });
  });

  it('keeps the saved embedded CPA key when no replacement key is submitted', () => {
    expect(
      resolveManagerCPAConnection({
        panelHostedByUsageService: true,
        managerConfig: buildManagerConfig({
          cpaConnection: {
            cpaBaseUrl: 'http://saved-cpa.local:8317',
            managementKey: 'old-cpa-key',
          },
        }),
        currentCPAApiBase: 'http://manager.local:18317',
        submittedCPAManagementKey: '   ',
        externalManagementKey: 'manager-admin-key',
      })
    ).toEqual({
      cpaBaseUrl: 'http://saved-cpa.local:8317',
      managementKey: 'old-cpa-key',
    });
  });

  it('uses the current CPA panel key for external panels unless an override is submitted', () => {
    expect(
      resolveManagerCPAConnection({
        panelHostedByUsageService: false,
        managerConfig: buildManagerConfig(),
        currentCPAApiBase: 'http://cpa.local:8317/',
        submittedCPAManagementKey: '',
        externalManagementKey: ' current-cpa-key ',
      })
    ).toEqual({
      cpaBaseUrl: 'http://cpa.local:8317/',
      managementKey: 'current-cpa-key',
    });

    expect(
      resolveManagerCPAConnection({
        panelHostedByUsageService: false,
        managerConfig: buildManagerConfig(),
        currentCPAApiBase: 'http://cpa.local:8317/',
        submittedCPAManagementKey: ' new-cpa-key ',
        externalManagementKey: 'current-cpa-key',
      })
    ).toEqual({
      cpaBaseUrl: 'http://cpa.local:8317/',
      managementKey: 'new-cpa-key',
    });
  });
});

describe('resolveManagerBindingStatus', () => {
  it('treats same-origin Manager Server panels as matched', () => {
    expect(
      resolveManagerBindingStatus({
        panelHostedByUsageService: true,
        currentCPAApiBase: 'http://cpa.local:8317',
        managerConfig: null,
      })
    ).toBe('matched');
  });

  it('distinguishes unconfigured, matched, disabled, and mismatched external bindings', () => {
    expect(
      resolveManagerBindingStatus({
        panelHostedByUsageService: false,
        currentCPAApiBase: 'http://cpa.local:8317',
        managerConfig: buildManagerConfig({
          cpaConnection: {
            cpaBaseUrl: '',
            managementKey: '',
          },
        }),
      })
    ).toBe('unconfigured');

    expect(
      resolveManagerBindingStatus({
        panelHostedByUsageService: false,
        currentCPAApiBase: 'http://cpa.local:8317/',
        managerConfig: buildManagerConfig(),
      })
    ).toBe('matched');

    expect(
      resolveManagerBindingStatus({
        panelHostedByUsageService: false,
        currentCPAApiBase: 'http://cpa.local:8317',
        managerConfig: buildManagerConfig({
          externalUsageService: {
            enabled: false,
            serviceBase: '',
          },
        }),
      })
    ).toBe('external_disabled');

    expect(
      resolveManagerBindingStatus({
        panelHostedByUsageService: false,
        currentCPAApiBase: 'http://other-cpa.local:8317',
        managerConfig: buildManagerConfig(),
      })
    ).toBe('mismatched');
  });
});

describe('resolveManagerSaveState', () => {
  it('allows saving to validate an external Manager Server admin key by itself', () => {
    expect(
      resolveManagerSaveState({
        panelHostedByUsageService: false,
        managerDirty: false,
        managerNeedsBindingSync: false,
        managerBindingSyncBlocked: false,
        managerAdminKey: ' manager-admin-key ',
        verifiedManagerAdminKey: '',
        managerServiceTarget: 'http://manager.local:18317/',
      })
    ).toEqual({
      adminKeyLoadPending: true,
      adminKeyOnlyPending: true,
      hasPendingSave: true,
      canSave: true,
    });
  });

  it('does not treat an admin key as pending in same-origin Manager Server panels', () => {
    expect(
      resolveManagerSaveState({
        panelHostedByUsageService: true,
        managerDirty: false,
        managerNeedsBindingSync: false,
        managerBindingSyncBlocked: false,
        managerAdminKey: ' manager-admin-key ',
        verifiedManagerAdminKey: '',
        managerServiceTarget: 'http://manager.local:18317/',
      })
    ).toEqual({
      adminKeyLoadPending: false,
      adminKeyOnlyPending: false,
      hasPendingSave: false,
      canSave: false,
    });
  });

  it('keeps blocked rebinds disabled until an admin key is provided', () => {
    expect(
      resolveManagerSaveState({
        panelHostedByUsageService: false,
        managerDirty: false,
        managerNeedsBindingSync: true,
        managerBindingSyncBlocked: true,
        managerAdminKey: '',
        verifiedManagerAdminKey: '',
        managerServiceTarget: 'http://manager.local:18317',
      })
    ).toMatchObject({
      hasPendingSave: true,
      canSave: false,
    });
  });

  it('stops treating the same validated admin key as a pending load', () => {
    expect(
      resolveManagerSaveState({
        panelHostedByUsageService: false,
        managerDirty: false,
        managerNeedsBindingSync: false,
        managerBindingSyncBlocked: false,
        managerAdminKey: ' manager-admin-key ',
        verifiedManagerAdminKey: 'manager-admin-key',
        managerServiceTarget: 'http://manager.local:18317',
      })
    ).toEqual({
      adminKeyLoadPending: false,
      adminKeyOnlyPending: false,
      hasPendingSave: false,
      canSave: false,
    });
  });
});

describe('shouldShowMissingManagerAdminKeyError', () => {
  it('shows the missing admin key error for manual external Manager Server loads', () => {
    expect(
      shouldShowMissingManagerAdminKeyError({
        panelHostedByUsageService: false,
        trigger: 'manual',
        hasManagerConfig: true,
      })
    ).toBe(true);
  });

  it('does not show the missing admin key error for automatic reloads after config is loaded', () => {
    expect(
      shouldShowMissingManagerAdminKeyError({
        panelHostedByUsageService: false,
        trigger: 'auto',
        hasManagerConfig: true,
      })
    ).toBe(false);
  });

  it('still shows the missing admin key error for first automatic external Manager Server load', () => {
    expect(
      shouldShowMissingManagerAdminKeyError({
        panelHostedByUsageService: false,
        trigger: 'auto',
        hasManagerConfig: false,
      })
    ).toBe(true);
  });

  it('does not require a Manager Server admin key for same-origin panels', () => {
    expect(
      shouldShowMissingManagerAdminKeyError({
        panelHostedByUsageService: true,
        trigger: 'manual',
        hasManagerConfig: false,
      })
    ).toBe(false);
  });
});
