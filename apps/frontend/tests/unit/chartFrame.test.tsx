// @vitest-environment jsdom
// A chart page's frame names what the chart is. A chart that leaves its
// frame text out -- a bar chart of test durations, a scatter of latency --
// is framed by its kind, not as a training run's loss trace, which is what
// every chart was called before the chart had kinds.
import { describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { renderScene, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

function renderChart(data: ChartData) {
  return renderScene([{ op: 'show', id: 'chart', type: 'chart', role: 'primary', data }]).querySelector('[data-scene="training"]')!;
}

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
