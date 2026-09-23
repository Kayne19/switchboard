// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MetricsPrimitive } from '../../src/primitives/MetricsPrimitive';
import type { MetricData, SceneObject } from '../../src/controller/types';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function renderMetrics(metrics: Array<SceneObject<MetricData>>, variant?: 'list' | 'primary' | 'rail') {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => {
    root.render(<MetricsPrimitive metrics={metrics} variant={variant} />);
  });
  return host;
}

describe('MetricsPrimitive', () => {
  const metric1: SceneObject<MetricData> = {
    id: 'gpu',
    type: 'metric',
    role: 'secondary',
    data: { label: 'GPU', value: '94%', semantic: 'orange' },
    createdAt: 100,
    updatedAt: 100,
  };

  const metric2: SceneObject<MetricData> = {
    id: 'eta',
    type: 'metric',
    role: 'secondary',
    data: { label: 'ETA', value: '01:42:18', semantic: 'paper' },
    createdAt: 100,
    updatedAt: 100,
  };

  it('renders list variant without rail telemetry header', () => {
    const host = renderMetrics([metric1, metric2], 'list');
    expect(host.querySelector('.metrics--list')).not.toBeNull();
    expect(host.querySelector('.metrics__header')).toBeNull();
    const rows = host.querySelectorAll('.metric-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('GPU');
    expect(rows[0].textContent).toContain('94%');
  });

  it('renders rail variant with telemetry header and channel count', () => {
    const host = renderMetrics([metric1, metric2], 'rail');
    expect(host.querySelector('.metrics--rail')).not.toBeNull();
    const header = host.querySelector('.metrics__header');
    expect(header).not.toBeNull();
    expect(header!.querySelector('.metrics__tag')?.textContent).toBe('TELEMETRY');
    expect(header!.querySelector('.metrics__index')?.textContent).toBe('2 CHANNELS');
    const rows = host.querySelectorAll('.metric-row');
    expect(rows).toHaveLength(2);
  });

  it('renders rail variant with single metric caption or default index', () => {
    const single: SceneObject<MetricData> = {
      id: 'latency',
      type: 'metric',
      role: 'secondary',
      data: { label: 'LATENCY', value: '182 ms', caption: 'EDGE / P95' },
      createdAt: 100,
      updatedAt: 100,
    };
    const host = renderMetrics([single], 'rail');
    const header = host.querySelector('.metrics__header');
    expect(header).not.toBeNull();
    expect(header!.querySelector('.metrics__tag')?.textContent).toBe('TELEMETRY');
    expect(header!.querySelector('.metrics__index')?.textContent).toBe('EDGE / P95');
  });
});
