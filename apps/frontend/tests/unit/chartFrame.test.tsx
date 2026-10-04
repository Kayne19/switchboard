// @vitest-environment jsdom
// A chart page's frame names what the chart is. A chart that leaves its
// frame text out -- a bar chart of test durations, a scatter of latency --
// is framed by its kind, not as a training run's loss trace, which is what
// every chart was called before the chart had kinds.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ChartData, ControllerAction } from '../../src/controller/types';

let host: HTMLDivElement;
let root: Root;

function Scene({ actions }: { actions: ControllerAction[] }) {
  const { run } = useController();
  useEffect(() => run(actions), [actions, run]);
  return null;
}

function renderChart(data: ChartData) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const actions: ControllerAction[] = [{ op: 'show', id: 'chart', type: 'chart', role: 'primary', data }];
  act(() => root.render(
    <ControllerProvider>
      <Scene actions={actions} />
      <SceneRenderer />
    </ControllerProvider>,
  ));
  return host.querySelector('[data-scene="training"]')!;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a chart page frame', () => {
  it.each([
    ['a bar', 'bar', 'BAR'],
    ['a scatter', 'scatter', 'SCATTER'],
    ['an area', 'area', 'AREA'],
    ['an unkinded', undefined, 'LINE'],
  ] as const)('names %s chart by its kind when the chart names nothing', (_, kind, name) => {
    const page = renderChart({ ...(kind ? { kind } : {}), series: [{ name: 'A', values: [3, 1, 2] }] });
    expect(page).not.toBeNull();
    const text = page.textContent ?? '';
    expect(page.querySelector('.scene-heading__title')!.textContent).toBe(`CHART / ${name}`);
    expect(text).toContain(`PRIMARY / ${name} CHART`);
    expect(text).not.toMatch(/LOSS TRACE|TRAINING/);
  });

  it('keeps the frame text a chart gives', () => {
    const page = renderChart({
      kind: 'bar', title: 'CI / DURATIONS', subtitle: 'WALL TIME', context: 'CI RUN', caption: 'PRIMARY / SUITES',
      series: [{ name: 'A', values: [3, 1, 2] }],
    });
    expect(page.querySelector('.scene-heading__title')!.textContent).toBe('CI / DURATIONS');
    expect(page.querySelector('.scene-heading__sub')!.textContent).toBe('WALL TIME');
    expect(page.textContent).toContain('PRIMARY / SUITES');
    expect(page.textContent).toContain('CI RUN');
  });
});
