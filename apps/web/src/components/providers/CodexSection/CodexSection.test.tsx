import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { ProviderKeyConfig } from '@/types';
import { CodexSection } from './CodexSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const getRows = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => node.type === 'div' && node.props.className === 'item-row');

const getText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : getText(child))).join('');

const clickButton = (button: ReactTestInstance) => {
  const onClick = button.props.onClick as (() => void) | undefined;
  if (!onClick) throw new Error('Button click handler not found');

  act(() => {
    onClick();
  });
};

const toggleSwitch = (toggle: ReactTestInstance, value: boolean) => {
  const onChange = toggle.props.onChange as ((value: boolean) => void) | undefined;
  if (!onChange) throw new Error('Toggle change handler not found');

  act(() => {
    onChange(value);
  });
};

const selectCheckbox = (checkbox: ReactTestInstance) => {
  const onChange = checkbox.props.onChange as ((value: boolean) => void) | undefined;
  if (!onChange) throw new Error('Checkbox change handler not found');

  act(() => {
    onChange(true);
  });
};

describe('CodexSection', () => {
  it('keeps sorted row actions mapped to original config indexes', () => {
    const configs: ProviderKeyConfig[] = [
      { apiKey: 'low-key', baseUrl: 'https://low.example.com/v1', priority: 1 },
      {
        apiKey: 'disabled-key',
        baseUrl: 'https://disabled.example.com/v1',
        priority: 99,
        excludedModels: ['*'],
      },
      { apiKey: 'high-key', baseUrl: 'https://high.example.com/v1', priority: 9 },
      { apiKey: 'unset-key', baseUrl: 'https://unset.example.com/v1' },
    ];
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onToggle = vi.fn();
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        <CodexSection
          configs={configs}
          usageByProvider={new Map()}
          loading={false}
          disableControls={false}
          isSwitching={false}
          onAdd={() => {}}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggle={onToggle}
        />
      );
    });

    const firstDescendingRow = getRows(renderer)[0];
    expect(getText(firstDescendingRow)).toContain('https://high.example.com/v1');

    const [editHighButton, deleteHighButton] = firstDescendingRow.findAllByType(Button);
    clickButton(editHighButton);
    clickButton(deleteHighButton);
    toggleSwitch(firstDescendingRow.findByType(ToggleSwitch), false);

    expect(onEdit).toHaveBeenLastCalledWith(2);
    expect(onDelete).toHaveBeenLastCalledWith(2);
    expect(onToggle).toHaveBeenLastCalledWith(2, false);
    const descendingRows = getRows(renderer);
    expect(getText(descendingRows[descendingRows.length - 1])).toContain(
      'https://disabled.example.com/v1'
    );

    const sortButton = renderer.root
      .findAllByType(Button)
      .find((button) => button.props['aria-label'] === 'ai_providers.sort_descending');
    if (!sortButton) throw new Error('Sort button not found');
    clickButton(sortButton);

    const firstAscendingRow = getRows(renderer)[0];
    expect(getText(firstAscendingRow)).toContain('https://unset.example.com/v1');

    const [editLowButton, deleteLowButton] = firstAscendingRow.findAllByType(Button);
    clickButton(editLowButton);
    clickButton(deleteLowButton);
    toggleSwitch(firstAscendingRow.findByType(ToggleSwitch), false);

    expect(onEdit).toHaveBeenLastCalledWith(3);
    expect(onDelete).toHaveBeenLastCalledWith(3);
    expect(onToggle).toHaveBeenLastCalledWith(3, false);
    const ascendingRows = getRows(renderer);
    expect(getText(ascendingRows[ascendingRows.length - 1])).toContain(
      'https://disabled.example.com/v1'
    );
  });

  it('uses the OpenAI-style sort selector and model filter without including disabled providers in sorting', () => {
    const configs: ProviderKeyConfig[] = [
      {
        apiKey: 'alpha-key',
        baseUrl: 'https://alpha.example.com/v1',
        priority: 1,
        models: [{ name: 'alpha-model' }],
      },
      {
        apiKey: 'disabled-key',
        baseUrl: 'https://disabled.example.com/v1',
        priority: 99,
        excludedModels: ['*'],
        models: [{ name: 'beta-model' }],
      },
      {
        apiKey: 'beta-key',
        baseUrl: 'https://beta.example.com/v1',
        priority: 9,
        models: [{ name: 'beta-model' }],
      },
    ];
    const onEdit = vi.fn();
    const onToggle = vi.fn();
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        <CodexSection
          configs={configs}
          usageByProvider={new Map()}
          loading={false}
          disableControls={false}
          isSwitching={false}
          onAdd={() => {}}
          onEdit={onEdit}
          onDelete={() => {}}
          onToggle={onToggle}
        />
      );
    });

    const sortSelect = renderer.root.findByType(Select);
    expect(sortSelect.props.options.map((option: { value: string }) => option.value)).toEqual([
      'priority',
      'name',
      'recent-success',
    ]);
    expect(sortSelect.props.ariaLabel).toBe('ai_providers.sort_by');

    const modelFilterButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === 'ai_providers.model_search_placeholder');
    if (!modelFilterButton) throw new Error('Model filter button not found');
    clickButton(modelFilterButton);

    const betaCheckbox = renderer.root
      .findAllByType(SelectionCheckbox)
      .find((checkbox) => getText(checkbox).includes('beta-model'));
    if (!betaCheckbox) throw new Error('Beta model checkbox not found');
    selectCheckbox(betaCheckbox);

    const filteredRows = getRows(renderer);
    expect(filteredRows).toHaveLength(2);
    expect(getText(filteredRows[0])).toContain('https://beta.example.com/v1');
    expect(getText(filteredRows[1])).toContain('https://disabled.example.com/v1');

    const [editButton] = filteredRows[0].findAllByType(Button);
    clickButton(editButton);
    toggleSwitch(filteredRows[0].findByType(ToggleSwitch), false);

    expect(onEdit).toHaveBeenLastCalledWith(2);
    expect(onToggle).toHaveBeenLastCalledWith(2, false);
  });

  it('clears stale model filters when configs no longer expose the selected model', () => {
    const initialConfigs: ProviderKeyConfig[] = [
      {
        apiKey: 'alpha-key',
        baseUrl: 'https://alpha.example.com/v1',
        priority: 1,
        models: [{ name: 'alpha-model' }],
      },
      {
        apiKey: 'beta-key',
        baseUrl: 'https://beta.example.com/v1',
        priority: 2,
        models: [{ name: 'beta-model' }],
      },
    ];
    const updatedConfigs: ProviderKeyConfig[] = [
      {
        apiKey: 'alpha-key',
        baseUrl: 'https://alpha.example.com/v1',
        priority: 1,
        models: [{ name: 'alpha-model' }],
      },
    ];
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        <CodexSection
          configs={initialConfigs}
          usageByProvider={new Map()}
          loading={false}
          disableControls={false}
          isSwitching={false}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onToggle={() => {}}
        />
      );
    });

    const modelFilterButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === 'ai_providers.model_search_placeholder');
    if (!modelFilterButton) throw new Error('Model filter button not found');
    clickButton(modelFilterButton);

    const betaCheckbox = renderer.root
      .findAllByType(SelectionCheckbox)
      .find((checkbox) => getText(checkbox).includes('beta-model'));
    if (!betaCheckbox) throw new Error('Beta model checkbox not found');
    selectCheckbox(betaCheckbox);

    expect(getRows(renderer)).toHaveLength(1);
    expect(getText(getRows(renderer)[0])).toContain('https://beta.example.com/v1');

    act(() => {
      renderer.update(
        <CodexSection
          configs={updatedConfigs}
          usageByProvider={new Map()}
          loading={false}
          disableControls={false}
          isSwitching={false}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onToggle={() => {}}
        />
      );
    });

    const rows = getRows(renderer);
    expect(rows).toHaveLength(1);
    expect(getText(rows[0])).toContain('https://alpha.example.com/v1');
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.props['aria-label'] === 'ai_providers.model_search_placeholder')
    ).toBe(true);
  });
});
