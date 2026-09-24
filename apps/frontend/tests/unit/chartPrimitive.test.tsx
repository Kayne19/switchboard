// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { ChartPrimitive, chartSeriesColor, chartXTicks } from '../../src/primitives/ChartPrimitive';
import { chartSeriesPoint } from '../../src/primitives/chartGeometry';

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


function renderWith(chart: ChartData) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ChartPrimitive data={chart} />));
}

const plotWidth = 1000 - 74 - 28;
const plotHeight = 500 - 34 - 54;

describe('chart traces (#46)', () => {
  it('never draws a series with a path-length dash pattern', () => {
    // The strokes are non-scaling, so a dash pattern measured in user space
    // is laid in screen space and stops the line short of its last point
    // whenever the chart is drawn larger than its viewBox.
    render();
    const paths = [...host.querySelectorAll<SVGPathElement>('.chart-series')];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
      expect(path.getAttribute('pathLength')).toBeNull();
      expect(path.getAttribute('stroke-dasharray')).toBeNull();
      expect(path.style.strokeDasharray).toBe('');
    }
  });

  it('runs each series from the first x to the last', () => {
    renderWith({ series: [{ name: 'Output', values: [42, 58, 75, 68, 92, 115] }] });
    const d = host.querySelector('.chart-series')!.getAttribute('d')!;
    const xs = [...d.matchAll(/[ML] ([\d.]+) /g)].map((match) => Number(match[1]));
    expect(xs).toHaveLength(6);
    expect(xs[0]).toBeCloseTo(74);
    expect(xs[5]).toBeCloseTo(1000 - 28);
  });
});

describe('chart x axis', () => {
  it('ticks at round values of the domain', () => {
    expect(chartXTicks(5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(chartXTicks(40)).toEqual([0, 10, 20, 30, 40]);
    expect(chartXTicks(3)).toEqual([0, 1, 2, 3]);
    expect(chartXTicks(63)).toEqual([0, 20, 40, 60]);
    expect(chartXTicks(1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(chartXTicks(0)).toEqual([0]);
  });

  it('labels each gridline with the x it sits at', () => {
    renderWith({ series: [{ name: 'Output', values: [42, 58, 75, 68, 92, 115] }] });
    const labels = [...host.querySelectorAll<SVGTextElement>('.chart-grid text[text-anchor="middle"]')];
    expect(labels.map((label) => label.textContent)).toEqual(['0', '1', '2', '3', '4', '5']);
    for (const label of labels) {
      expect(Number(label.getAttribute('x'))).toBeCloseTo(74 + (Number(label.textContent) / 5) * plotWidth);
    }
  });

  it('closes the grid at the right edge when no round value lands there', () => {
    renderWith({ series: [{ name: 'RUN', values: [1, 2, 3] }], xMax: 63 });
    const verticals = [...host.querySelectorAll<SVGLineElement>('.chart-grid line')].filter(
      (line) => line.getAttribute('x1') === line.getAttribute('x2'),
    );
    expect(verticals.map((line) => Number(line.getAttribute('x1')))).toContain(1000 - 28);
    const labels = [...host.querySelectorAll<SVGTextElement>('.chart-grid text[text-anchor="middle"]')].map((label) => label.textContent);
    expect(labels).toEqual(['0', '20', '40', '60']);
  });
});

// The point a note names, in the chart's viewBox: the note layer runs its
// leader to it, so it must be the point the chart draws.
describe('chart series point', () => {
  it('reaches the real series point', () => {
    // GAMMA runs 3 -> 4 across x 0 -> 1 on a 1..6 scale.
    const point = chartSeriesPoint(data, 1, 'GAMMA')!;
    expect(point.x).toBeCloseTo(1000 - 28, 1);
    expect(point.y).toBeCloseTo(34 + (1 - (4 - 1) / (6 - 1)) * plotHeight, 1);
  });

  it('lands on the drawn segment when x falls between samples', () => {
    // Samples at x = 0, 2, 4, 6; x = 1 is halfway along the first segment,
    // which the path draws straight from 0 to 6.
    const point = chartSeriesPoint({ series: [{ name: 'SAW', values: [0, 6, 0, 6] }], xMax: 6, yMin: 0, yMax: 6 }, 1, 'SAW')!;
    expect(point.x).toBeCloseTo(74 + plotWidth / 6, 1);
    expect(point.y).toBeCloseTo(34 + plotHeight / 2, 1);
  });

  it('holds an out-of-range x at the end of the plot instead of off it', () => {
    const chart: ChartData = { series: [{ name: 'VALID', values: [2, 2, 1, 1] }], xMax: 3, yMin: 1, yMax: 4 };
    const point = chartSeriesPoint(chart, 9, 'VALID')!;
    expect(point.x).toBeCloseTo(1000 - 28, 1);
    // The y is the last sample's, the same point the path ends on.
    expect(point.y).toBeCloseTo(34 + (1 - (1 - 1) / (4 - 1)) * plotHeight, 1);
  });

  it('falls back to the first series for a name the chart does not carry', () => {
    expect(chartSeriesPoint(data, 0, 'NOPE')).toEqual(chartSeriesPoint(data, 0, 'ALPHA'));
  });

  it('names no point on a chart with no x domain', () => {
    expect(chartSeriesPoint({ series: [{ name: 'A', values: [1, 2] }], xMax: 0 }, 1)).toBeUndefined();
    expect(chartSeriesPoint({ series: [{ name: 'A', values: [] }] }, 1)).toBeUndefined();
  });

  it('lands where the chart draws its own marker for the same x', () => {
    const chart: ChartData = {
      series: [
        { name: 'LOSS', values: [4, 3, 2, 1] },
        { name: 'VALID', values: [2, 2, 1, 1] },
      ],
      xMax: 3,
      marker: { x: 3, series: 'LOSS' },
    };
    renderWith(chart);
    const marker = host.querySelector<SVGCircleElement>('.chart-marker__point')!;
    const point = chartSeriesPoint(chart, 3, 'LOSS')!;
    expect(point.x).toBeCloseTo(Number(marker.getAttribute('cx')), 1);
    expect(point.y).toBeCloseTo(Number(marker.getAttribute('cy')), 1);
  });

  it('leaves the leader to the note layer: the chart draws no pointer of its own', () => {
    render();
    expect(host.querySelector('.chart-pointer')).toBeNull();
    expect(host.querySelector('polygon')).toBeNull();
  });
});
