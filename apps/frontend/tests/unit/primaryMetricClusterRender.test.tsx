// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ControllerAction, ControllerState, MetricData, SceneObject } from '../../src/controller/types';
import { controllerReducer, createInitialState } from '../../src/controller/reducer';
import { MetricsPrimitive } from '../../src/primitives/MetricsPrimitive';
import { ComposedScene } from '../../src/components/Scenes';

function reduceActions(state: ControllerState, actions: ControllerAction[]): ControllerState {
  return actions.reduce(controllerReducer, state);
}

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
  }
  if (host) {
    host.remove();
  }
});

const m1: SceneObject<MetricData> = {
  id: 'm1',
  type: 'metric',
  role: 'primary',
  data: { label: 'CPU', value: '45%' },
  createdAt: 1,
  updatedAt: 1,
  primaryClaimedAt: 1,
};

const m2: SceneObject<MetricData> = {
  id: 'm2',
  type: 'metric',
  role: 'primary',
  data: { label: 'MEM', value: '62%' },
  createdAt: 2,
  updatedAt: 2,
  primaryClaimedAt: 2,
};

const m3: SceneObject<MetricData> = {
  id: 'm3',
  type: 'metric',
  role: 'primary',
  data: { label: 'DISK', value: '88%' },
  createdAt: 3,
  updatedAt: 3,
  primaryClaimedAt: 3,
};

describe('primary metric cluster rendering', () => {
  it('renders a single metric as primary without cluster class', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root.render(<MetricsPrimitive metrics={[m1]} variant="primary" />);
    });

    const metricsEl = host.querySelector('.metrics');
    expect(metricsEl).not.toBeNull();
    expect(metricsEl?.classList.contains('metrics--primary')).toBe(true);
    expect(metricsEl?.classList.contains('metrics--cluster')).toBe(false);
    expect(metricsEl?.getAttribute('data-count')).toBe('1');

    const rows = host.querySelectorAll('.metric-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.metric-row__label')?.textContent).toBe('CPU');
    expect(rows[0].querySelector('.metric-row__value')?.textContent).toBe('45%');
  });

  it('renders multiple metrics as a cluster with data-count attribute', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root.render(<MetricsPrimitive metrics={[m1, m2, m3]} variant="primary" />);
    });

    const metricsEl = host.querySelector('.metrics');
    expect(metricsEl).not.toBeNull();
    expect(metricsEl?.classList.contains('metrics--primary')).toBe(true);
    expect(metricsEl?.classList.contains('metrics--cluster')).toBe(true);
    expect(metricsEl?.getAttribute('data-count')).toBe('3');

    const rows = host.querySelectorAll('.metric-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('.metric-row__label')?.textContent).toBe('CPU');
    expect(rows[1].querySelector('.metric-row__label')?.textContent).toBe('MEM');
    expect(rows[2].querySelector('.metric-row__label')?.textContent).toBe('DISK');
  });

  it('triggers onFocus with clicked metric id in a cluster', () => {
    const onFocus = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root.render(<MetricsPrimitive metrics={[m1, m2, m3]} variant="primary" onFocus={onFocus} />);
    });

    const rows = host.querySelectorAll<HTMLDivElement>('.metric-row');
    act(() => {
      rows[1].click();
    });

    expect(onFocus).toHaveBeenCalledWith('m2');
  });

  it('renders ComposedScene with primary cluster in main and non-primary metrics in rail', () => {
    const actions: ControllerAction[] = [
      { op: 'show', id: 'm1', type: 'metric', role: 'primary', data: { label: 'CPU', value: '45%' } },
      { op: 'show', id: 'm2', type: 'metric', role: 'primary', data: { label: 'MEM', value: '62%' } },
      { op: 'show', id: 'm-rail', type: 'metric', role: 'secondary', data: { label: 'RAIL METRIC', value: '99%' } },
    ];
    const state = reduceActions(createInitialState(), actions);

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root.render(
        <ComposedScene
          state={state}
          onToggleListening={() => {}}
          onFocus={() => {}}
          setTranscriptOpen={() => {}}
        />,
      );
    });

    // Check cluster in main
    const mainCluster = host.querySelector('.composed-primary-object--cluster');
    expect(mainCluster).not.toBeNull();

    const mainMetrics = mainCluster?.querySelectorAll('.metric-row');
    expect(mainMetrics).toHaveLength(2);
    expect(mainMetrics?.[0].querySelector('.metric-row__label')?.textContent).toBe('CPU');
    expect(mainMetrics?.[1].querySelector('.metric-row__label')?.textContent).toBe('MEM');

    // Check rail only has the secondary metric
    const railDetails = host.querySelector('.content-rail__details');
    expect(railDetails).not.toBeNull();
    const railMetricRows = railDetails?.querySelectorAll('.metric-row');
    expect(railMetricRows).toHaveLength(1);
    expect(railMetricRows?.[0].querySelector('.metric-row__label')?.textContent).toBe('RAIL METRIC');
  });
});
