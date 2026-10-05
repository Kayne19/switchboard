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

  it('renders list variant rows', () => {
    const host = renderMetrics([metric1, metric2], 'list');
    expect(host.querySelector('.metrics--list')).not.toBeNull();
    const rows = host.querySelectorAll('.metric-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('GPU');
    expect(rows[0].textContent).toContain('94%');
  });

  it('renders rail variant as its rows alone, with no header line (#32)', () => {
    const host = renderMetrics([metric1, metric2], 'rail');
    const metrics = host.querySelector('.metrics--rail');
    expect(metrics).not.toBeNull();
    expect(host.querySelector('.metrics__header')).toBeNull();
    expect(host.textContent).not.toContain('TELEMETRY');
    expect(host.textContent).not.toContain('CHANNELS');
    const rows = metrics!.querySelectorAll(':scope > .metric-row');
    expect(rows).toHaveLength(2);
    expect(metrics!.firstElementChild).toBe(rows[0]);
  });

  it('renders a single rail metric without a caption line', () => {
    const single: SceneObject<MetricData> = {
      id: 'latency',
      type: 'metric',
      role: 'secondary',
      data: { label: 'LATENCY', value: '182 ms', caption: 'EDGE / P95' },
      createdAt: 100,
      updatedAt: 100,
    };
    const host = renderMetrics([single], 'rail');
    expect(host.querySelector('.metrics__header')).toBeNull();
    expect(host.textContent).toBe('LATENCY182 ms');
  });

  it('draws a trend arrow and the delta beside the value, in the value\'s colour', () => {
    const moved: SceneObject<MetricData> = {
      ...metric1,
      data: { label: 'P95', value: '182 ms', semantic: 'cyan', trend: 'down', delta: '-12 ms' },
    };
    const host = renderMetrics([moved], 'rail');
    const value = host.querySelector('.metric-row__value')!;
    expect(value.classList.contains('semantic-cyan')).toBe(true);
    const trend = value.querySelector('[data-testid="metric-trend"]')!;
    expect(trend).not.toBeNull();
    expect(trend.getAttribute('data-trend')).toBe('down');
    expect(trend.querySelector('.metric-row__arrow')?.getAttribute('aria-label')).toBe('down');
    expect(trend.querySelector('.metric-row__delta')?.textContent).toBe('-12 ms');
    expect(value.textContent).toBe('182 ms-12 ms');
  });

  it('draws a delta without an arrow, and an arrow without a delta', () => {
    const deltaOnly = renderMetrics([{ ...metric1, data: { label: 'GPU', value: '94%', delta: '+3%' } }]);
    expect(deltaOnly.querySelector('.metric-row__arrow')).toBeNull();
    expect(deltaOnly.querySelector('.metric-row__delta')?.textContent).toBe('+3%');
    const arrowOnly = renderMetrics([{ ...metric1, data: { label: 'GPU', value: '94%', trend: 'flat' } }]);
    expect(arrowOnly.querySelector('.metric-row__arrow')?.getAttribute('aria-label')).toBe('flat');
    expect(arrowOnly.querySelector('.metric-row__delta')).toBeNull();
  });

  it('draws nothing beside a value that has neither', () => {
    const host = renderMetrics([metric1]);
    expect(host.querySelector('[data-testid="metric-trend"]')).toBeNull();
  });

  it('expands a metric in a cluster on a tap the page still hears', () => {
    const focused: string[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const heard: string[] = [];
    const listen = () => heard.push('click');
    document.addEventListener('click', listen);
    try {
      act(() => {
        root.render(<MetricsPrimitive metrics={[metric1, metric2]} variant="primary" onFocus={(id) => focused.push(id)} />);
      });
      act(() => host.querySelectorAll<HTMLElement>('.metric-row')[1].click());
      expect(focused).toEqual(['eta']);
      // Before: the row stopped its click, so the document-level listener
      // that unlocks audio never heard the tap.
      expect(heard).toEqual(['click']);
    } finally {
      document.removeEventListener('click', listen);
      act(() => root.unmount());
      host.remove();
    }
  });

  it('returns null when variant is rail and metrics list is empty', () => {
    const host = renderMetrics([], 'rail');
    expect(host.querySelector('.metrics')).toBeNull();
  });
});
