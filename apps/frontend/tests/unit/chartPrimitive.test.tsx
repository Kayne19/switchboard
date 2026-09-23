// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { ChartPrimitive, chartSeriesColor } from '../../src/primitives/ChartPrimitive';

const data: ChartData = {
  series: [
    { name: 'ALPHA', values: [1, 2] },
    { name: 'BETA', values: [2, 3] },
    { name: 'GAMMA', values: [3, 4] },
    { name: 'DELTA', values: [4, 5] },
    { name: 'EXPLICIT', semantic: 'red', values: [5, 6] },
  ],
};

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
});

function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ChartPrimitive data={data} />));
}

describe('chart series colors', () => {
  it('assigns distinguishable semantic fallbacks beyond the first two series', () => {
    const colors = data.series.map(chartSeriesColor);

    expect(colors.slice(0, 4)).toEqual([
      'var(--green)',
      'var(--orange)',
      'var(--cyan)',
      'var(--amber)',
    ]);
    expect(new Set(colors.slice(0, 4)).size).toBe(4);
    expect(colors[4]).toBe('var(--red)');
  });

  it('uses the same resolved color for each path and its legend key', () => {
    render();

    const paths = [...host.querySelectorAll<SVGPathElement>('.chart-series')];
    const keys = [...host.querySelectorAll<SVGLineElement>('.chart-legend__key')];
    expect(paths).toHaveLength(data.series.length);
    expect(keys).toHaveLength(data.series.length);
    expect(paths.map((path) => path.getAttribute('stroke'))).toEqual(
      keys.map((key) => key.getAttribute('stroke')),
    );
  });
});


describe('chart pointer', () => {
  it('draws a pointer reaching the real series point when anchor has x', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <ChartPrimitive
          data={data}
          annotation={{ x: 1, series: 'GAMMA' }}
        />,
      ),
    );

    const pointer = host.querySelector('.chart-pointer');
    expect(pointer).not.toBeNull();
    const stem = host.querySelector<SVGLineElement>('.chart-pointer__stem');
    const marker = host.querySelector<SVGCircleElement>('.chart-pointer__marker');
    expect(stem).not.toBeNull();
    expect(marker).not.toBeNull();
    expect(stem?.getAttribute('y2')).toBe(marker?.getAttribute('cy'));
    expect(stem?.getAttribute('x1')).toBe(marker?.getAttribute('cx'));
    expect(stem?.getAttribute('x2')).toBe(marker?.getAttribute('cx'));
  });

  it('draws no pointer when anchor does not have x', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <ChartPrimitive
          data={data}
          annotation={{ series: 'GAMMA' }}
        />,
      ),
    );

    const pointer = host.querySelector('.chart-pointer');
    expect(pointer).toBeNull();
  });
});


describe('marker and annotation interaction', () => {
  const markerData: ChartData = {
    series: [
      { name: 'LOSS', values: [4, 3, 2, 1] },
      { name: 'VALID', values: [2, 2, 1, 1] },
    ],
    xMax: 3,
    marker: { x: 3, series: 'LOSS' },
  };

  function renderWith(data: ChartData, annotation?: { x?: number; series?: string; cardEdge?: { x: number; y: number } }) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<ChartPrimitive data={data} annotation={annotation} />));
  }

  it('keeps the marker point when the annotation points elsewhere', () => {
    renderWith(markerData, { x: 1, series: 'VALID' });
    expect(host.querySelector('.chart-pointer__marker')).not.toBeNull();
    expect(host.querySelector('.chart-marker__point')).not.toBeNull();
  });

  it('hides the marker point only when the annotation lands on that exact point', () => {
    renderWith(markerData, { x: 3, series: 'LOSS' });
    expect(host.querySelector('.chart-marker__point')).toBeNull();
    expect(host.querySelector('.chart-pointer__marker')).not.toBeNull();
  });

  it('leaves the measured card edge and reaches the point when the card edge is supplied', () => {
    renderWith(markerData, { x: 1, series: 'VALID', cardEdge: { x: 400, y: 90 } });
    const stem = host.querySelector<SVGLineElement>('.chart-pointer__stem');
    const marker = host.querySelector<SVGCircleElement>('.chart-pointer__marker');
    expect(stem?.getAttribute('x1')).toBe('400');
    expect(stem?.getAttribute('y1')).toBe('90');
    expect(stem?.getAttribute('x2')).toBe(marker?.getAttribute('cx'));
    expect(stem?.getAttribute('y2')).toBe(marker?.getAttribute('cy'));
  });

  it('starts the leader at the plot top, not the frame border, until the card is measured', () => {
    renderWith(markerData, { x: 1, series: 'VALID' });
    const stem = host.querySelector<SVGLineElement>('.chart-pointer__stem');
    const marker = host.querySelector<SVGCircleElement>('.chart-pointer__marker');
    expect(stem?.getAttribute('y1')).toBe('34');
    expect(stem?.getAttribute('x1')).toBe(marker?.getAttribute('cx'));
  });
});
