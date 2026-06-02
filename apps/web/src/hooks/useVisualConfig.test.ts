import { act, createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useVisualConfig } from './useVisualConfig';

type UseVisualConfigResult = ReturnType<typeof useVisualConfig>;

type UseVisualConfigHarness = {
  getCurrent: () => UseVisualConfigResult;
  unmount: () => void;
};

function HookHarness({ hookRef }: { hookRef: Ref<UseVisualConfigResult> }) {
  const hook = useVisualConfig();
  useImperativeHandle(hookRef, () => hook, [hook]);
  return null;
}

const mountUseVisualConfig = (): UseVisualConfigHarness => {
  const hookRef = createRef<UseVisualConfigResult>();
  let renderer: ReactTestRenderer | null = null;

  act(() => {
    renderer = create(createElement(HookHarness, { hookRef }));
  });

  return {
    getCurrent: () => {
      if (!hookRef.current) {
        throw new Error('Failed to mount useVisualConfig test harness');
      }
      return hookRef.current;
    },
    unmount: () => {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

describe('useVisualConfig', () => {
  it('clears camelCase codex identityConfuse when disabling from visual editor', () => {
    const harness = mountUseVisualConfig();
    const yaml = [
      'host: 127.0.0.1',
      'codex:',
      '  identityConfuse: true',
      '  other-setting: kept',
      '',
    ].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });
    expect(harness.getCurrent().visualValues.codexIdentityConfuse).toBe(true);

    act(() => {
      harness.getCurrent().setVisualValues({ codexIdentityConfuse: false });
    });

    const savedYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
    expect(savedYaml).not.toContain('identityConfuse: true');
    expect(savedYaml).not.toContain('identityConfuse:');
    expect(savedYaml).toContain('identity-confuse: false');
    expect(savedYaml).toContain('other-setting: kept');

    harness.unmount();
  });
});
