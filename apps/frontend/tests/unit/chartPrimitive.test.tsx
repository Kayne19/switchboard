// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { ChartPrimitive, chartSeriesColor, chartXTicks } from '../../src/primitives/ChartPrimitive';
import { CHART_LEGEND_ROW_HEIGHT, CHART_LEGEND_STEP, chartLegendLayout, chartPad, chartSeriesPoint } from '../../src/primitives/chartGeometry';

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

  it('marks a point with a ring alone, with no guide line through the plot', () => {
    renderWith({
      series: [{ name: 'LOSS', values: [4, 3, 2, 1] }],
      xMax: 3,
      marker: { x: 2, series: 'LOSS' },
    });
    const marker = host.querySelector('.chart-marker')!;
    expect(marker.querySelectorAll('.chart-marker__point')).toHaveLength(1);
    expect(marker.querySelector('line')).toBeNull();
    expect(host.querySelector('svg [stroke-dasharray]')).toBeNull();
  });

  it('puts the marker ring on the drawn segment when its x falls between samples', () => {
    // Samples at x = 0, 2, 4, 6; x = 1 is halfway up the first segment, 0 -> 6.
    const chart: ChartData = { series: [{ name: 'SAW', values: [0, 6, 0, 6] }], xMax: 6, yMin: 0, yMax: 6, marker: { x: 1 } };
    renderWith(chart);
    const marker = host.querySelector<SVGCircleElement>('.chart-marker__point')!;
    const plotHeight = 500 - 34 - 54;
    expect(Number(marker.getAttribute('cy'))).toBeCloseTo(34 + plotHeight / 2, 1);
    expect(Number(marker.getAttribute('cx'))).toBeCloseTo(chartSeriesPoint(chart, 1)!.x, 1);
  });

  it('leaves the leader to the note layer: the chart draws no pointer of its own', () => {
    render();
    expect(host.querySelector('.chart-pointer')).toBeNull();
    expect(host.querySelector('polygon')).toBeNull();
  });
});

// Legend items advance by their own content instead of a fixed step, so a
// long series name no longer runs into the next key (#54).
describe('chart legend layout (#54)', () => {
  function legendItems(): { transform: string; text: string; title: string | null }[] {
    return [...host.querySelectorAll<SVGGElement>('.chart-legend > g')].map((g) => ({
      transform: g.getAttribute('transform')!,
      text: g.querySelector('text')!.textContent ?? '',
      title: g.querySelector('title')?.textContent ?? null,
    }));
  }

  it('keeps the short-label legend at its original fixed step and one-row plot padding', () => {
    // `data` (ALPHA, BETA, GAMMA, DELTA, EXPLICIT) is exactly the case the
    // visual goldens cover: every name is short enough that the dynamic
    // layout never needs more than the old fixed step.
    renderWith(data);
    const items = legendItems();
    expect(items).toHaveLength(data.series.length);
    items.forEach((item, index) => {
      expect(item.transform).toBe(`translate(${index * CHART_LEGEND_STEP} 0)`);
    });
    const clipRect = host.querySelector('svg > defs > clipPath > rect')!;
    expect(Number(clipRect.getAttribute('y'))).toBe(34);
    expect(Number(clipRect.getAttribute('height'))).toBe(plotHeight);
  });

  it('advances a long label by its own width, clearing the next key instead of overlapping it', () => {
    const longName = 'A VERY LONG SERIES NAME THAT USED TO OVERLAP THE NEXT KEY';
    renderWith({ series: [{ name: longName, values: [1, 2] }, { name: 'SHORT', values: [1, 2] }] });
    const items = legendItems();
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe(longName);
    // Both still fit on the first row...
    expect(items[0].transform).toBe('translate(0 0)');
    expect(items[1].transform).not.toMatch(/translate\(0 /);
    // ...but the second key starts well past the fixed step, because the
    // first label's real content needed the room.
    const secondX = Number(items[1].transform.match(/translate\(([\d.]+) /)![1]);
    expect(secondX).toBeGreaterThan(CHART_LEGEND_STEP);
    // The layout the primitive rendered from is the geometry to check the
    // room against: the second item never starts before the first item's
    // text plus its clearance gap ends.
    const layout = chartLegendLayout({ series: [{ name: longName, values: [] }, { name: 'SHORT', values: [] }] });
    expect(layout.items[0].row).toBe(layout.items[1].row);
    expect(secondX).toBeCloseTo(layout.items[1].x, 5);
  });

  it('wraps onto a further row once a row of realistic labels runs out of plot width', () => {
    const series = Array.from({ length: 5 }, (_, index) => ({
      name: `SERIES-${index}`.padEnd(20, 'X'),
      values: [1, 2],
    }));
    renderWith({ series });
    const items = legendItems();
    expect(items).toHaveLength(5);
    const rows = items.map((item) => Number(item.transform.match(/translate\([\d.]+ ([\d.]+)\)/)![1]));
    // The first four fit the first row; the fifth wraps.
    expect(rows.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(rows[4]).toBe(CHART_LEGEND_ROW_HEIGHT);
    // No item on a shared row overlaps the next: each one's real content
    // (its key, gap, and label) ends before the next one's key begins.
    for (let index = 0; index + 1 < items.length; index += 1) {
      if (rows[index] !== rows[index + 1]) continue;
      const x = Number(items[index].transform.match(/translate\(([\d.]+) /)![1]);
      const nextX = Number(items[index + 1].transform.match(/translate\(([\d.]+) /)![1]);
      expect(nextX).toBeGreaterThan(x);
    }
    // The plot grew room for the wrapped row instead of sitting under it.
    const pad = chartPad({ series });
    expect(pad.top).toBe(34 + CHART_LEGEND_ROW_HEIGHT);
    const clipRect = host.querySelector('svg > defs > clipPath > rect')!;
    expect(Number(clipRect.getAttribute('y'))).toBe(pad.top);
  });

  it('truncates a label with an ellipsis when it cannot fit even a row to itself, and keeps the full name available', () => {
    const longName = 'X'.repeat(400);
    renderWith({ series: [{ name: longName, values: [1, 2] }] });
    const items = legendItems();
    expect(items).toHaveLength(1);
    expect(items[0].text.length).toBeLessThan(longName.length);
    expect(items[0].text.endsWith('…')).toBe(true);
    // The full name is still available, e.g. on hover, via the title.
    expect(items[0].title).toBe(longName);
    // The truncated label actually fits the plot it was drawn in.
    const layout = chartLegendLayout({ series: [{ name: longName, values: [] }] });
    const plotWidth = 1000 - 74 - 28;
    expect(layout.items[0].x + 34 + layout.items[0].text.length * 7.5).toBeLessThanOrEqual(plotWidth + 0.01);
  });
});
