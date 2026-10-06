// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { ChartPrimitive, chartSeriesColor, chartXTicks } from '../../src/primitives/ChartPrimitive';
import {
  CHART_LEGEND_ROW_HEIGHT,
  CHART_MARKER_RADIUS,
  CHART_MARKER_STROKE,
  CHART_POINT_RADIUS,
  CHART_LEGEND_STEP,
  CHART_TICK_CHAR_ADVANCE,
  CHART_TICK_GAP,
  CHART_TICK_ROW_HEIGHT,
  CHART_READABLE_SCALE,
  chartBars,
  chartLegendLayout,
  chartPad,
  chartObstacles,
  chartScales,
  chartScrollHeight,
  chartSeriesPoint,
} from '../../src/primitives/chartGeometry';

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
  // The chart measures its slot; jsdom lays nothing out, so the slot reads
  // 0 x 0 and the chart keeps the approved canvas unless a test sizes it.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

  // The marker's ring is drawn whole past the plot's clip (it was cut in
  // half on the plot's edge), and a point a note names is ringed only where
  // no leader on the chart reaches it: a note in the rail, the band or a
  // focus panel. A note laid over the chart marks its point with its leader,
  // on the line itself, with no value printed there.
  it('rings each point a note names that no leader reaches, hollow, and none a leader reaches, whole past the plot\'s clip', () => {
    const chart: ChartData = { xMax: 3, yMin: 0, yMax: 5, series: [{ name: 'LOSS', values: [5, 3, 2, 1] }], marker: { x: 3 } };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<ChartPrimitive data={chart} named={[{ x: 0 }, { x: 1 }, { x: 3 }]} led={[{ x: 1 }]} />));
    const scales = chartScales(chart);
    const marker = host.querySelector('.chart-marker__point')!;
    expect(marker.closest('[clip-path]')).toBeNull();
    expect(marker.getAttribute('fill')).toBe('#000');
    expect(Number(marker.getAttribute('cx'))).toBeCloseTo(chartSeriesPoint(chart, 3, undefined, scales)!.x, 3);
    // The first note's point alone: the second's leader reaches it, the third names the marker's.
    const rings = [...host.querySelectorAll('.chart-note-ring')];
    expect(rings).toHaveLength(1);
    expect(rings[0].closest('[clip-path]')).toBeNull();
    const first = chartSeriesPoint(chart, 0, undefined, scales)!;
    expect(Number(rings[0].getAttribute('cx'))).toBeCloseTo(first.x, 3);
    expect(Number(rings[0].getAttribute('cy'))).toBeCloseTo(first.y, 3);
    expect(Number(rings[0].getAttribute('r'))).toBe(CHART_MARKER_RADIUS);
    expect(host.querySelector('.chart-marker__value')).toBeNull();
  });

  it("rings a scatter's marker without hiding the point, and fills a line's ring over the line", () => {
    renderWith({ kind: 'scatter', xMax: 3, series: [{ name: 'A', values: [4, 3, 2, 1] }], marker: { x: 2 } });
    expect(host.querySelector('.chart-marker__point')!.getAttribute('fill')).toBe('none');
    act(() => root.unmount());
    host.remove();
    renderWith({ xMax: 3, series: [{ name: 'A', values: [4, 3, 2, 1] }], marker: { x: 2 } });
    expect(host.querySelector('.chart-marker__point')!.getAttribute('fill')).toBe('#000');
  });

  it('rings every point a note names where no leader is given: focus, a cell beside the primary', () => {
    renderWith({ xMax: 3, series: [{ name: 'A', values: [4, 3, 2, 1] }] });
    expect(host.querySelectorAll('.chart-note-ring')).toHaveLength(0);
    act(() => root.render(<ChartPrimitive data={{ xMax: 3, series: [{ name: 'A', values: [4, 3, 2, 1] }] }} focused named={[{ x: 1 }, { x: 2 }]} />));
    expect(host.querySelectorAll('.chart-note-ring')).toHaveLength(2);
  });

  // Focus drew the ring 2 units wider and a scatter's points 1 wider than
  // the geometry the notes' clearances are worked out from (line-notes
  // review L2).
  it('draws the ring and the points in focus at the radius the geometry keeps clear of', () => {
    for (const kind of ['line', 'scatter'] as const) {
      const chart: ChartData = { kind, xMax: 3, series: [{ name: 'A', values: [4, 3, 2, 1] }], marker: { x: 2 } };
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      act(() => root.render(<ChartPrimitive data={chart} focused />));
      const ring = host.querySelector('.chart-marker__point')!;
      expect(Number(ring.getAttribute('r'))).toBe(CHART_MARKER_RADIUS);
      const obstacle = chartObstacles(chart).marks.at(-1)!;
      expect((obstacle.right - obstacle.left) / 2).toBe(Number(ring.getAttribute('r')) + CHART_MARKER_STROKE / 2);
      for (const point of host.querySelectorAll('.chart-point')) expect(Number(point.getAttribute('r'))).toBe(CHART_POINT_RADIUS);
      act(() => root.unmount());
      host.remove();
    }
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

// A chart's kind says how its series are drawn; the labels replace the
// numeric x ticks. The geometry behind both is tested in
// chartCategoryLayout.test.ts; here is what the primitive draws from it.
describe('chart kinds', () => {
  const labelled: ChartData = {
    labels: ['backend', 'frontend', 'skill'],
    series: [
      { name: 'THIS RUN', semantic: 'green', values: [41.2, 18.7, 3.1] },
      { name: 'PREVIOUS', semantic: 'muted', values: [44.0, 19.9] },
    ],
  };

  it('draws a line by default, and says so', () => {
    renderWith(labelled);
    expect(host.querySelector('.chart-primitive')!.getAttribute('data-kind')).toBe('line');
    expect(host.querySelectorAll('.chart-series')).toHaveLength(2);
    expect(host.querySelectorAll('.chart-bar, .chart-point, .chart-area')).toHaveLength(0);
  });

  it('draws grouped bars per category, each in its series colour, with a legend key to match', () => {
    renderWith({ ...labelled, kind: 'bar' });
    expect(host.querySelector('.chart-primitive')!.getAttribute('data-kind')).toBe('bar');
    expect(host.querySelector('.chart-primitive')!.getAttribute('data-orientation')).toBe('upright');
    expect(host.querySelectorAll('.chart-series')).toHaveLength(0);
    const groups = [...host.querySelectorAll<SVGGElement>('.chart-series-group')];
    expect(groups.map((group) => group.querySelectorAll('.chart-bar').length)).toEqual([3, 2]);
    const fills = groups.map((group) => group.querySelector('.chart-bar')!.getAttribute('fill'));
    expect(fills).toEqual(['var(--green)', 'var(--muted)']);
    const keys = [...host.querySelectorAll<SVGRectElement>('.chart-legend__key')];
    expect(keys.map((key) => key.tagName.toLowerCase())).toEqual(['rect', 'rect']);
    expect(keys.map((key) => key.getAttribute('fill'))).toEqual(fills);
    // The bars stand on the baseline, which is drawn.
    expect(host.querySelector('.chart-baseline')).not.toBeNull();
    const bars = chartBars({ ...labelled, kind: 'bar' });
    const drawn = [...host.querySelectorAll<SVGRectElement>('.chart-bar')];
    drawn.forEach((rect, index) => {
      expect(Number(rect.getAttribute('x'))).toBeCloseTo(bars[index].rect.left, 1);
      expect(Number(rect.getAttribute('y'))).toBeCloseTo(bars[index].rect.top, 1);
    });
  });

  it('fills an area from the line down to the baseline', () => {
    renderWith({ ...labelled, kind: 'area' });
    const areas = [...host.querySelectorAll<SVGPathElement>('.chart-area')];
    const lines = [...host.querySelectorAll<SVGPathElement>('.chart-series')];
    expect(areas).toHaveLength(2);
    expect(lines).toHaveLength(2);
    areas.forEach((area, index) => {
      expect(area.getAttribute('fill')).toBe(lines[index].getAttribute('stroke'));
      expect(Number(area.getAttribute('fill-opacity'))).toBeLessThan(0.5);
      // The fill's outline is the line's path, closed down to the baseline.
      expect(area.getAttribute('d')!.startsWith(lines[index].getAttribute('d')!)).toBe(true);
      expect(area.getAttribute('d')!.endsWith('Z')).toBe(true);
    });
    expect(host.querySelector('.chart-baseline')).not.toBeNull();
  });

  it('draws a scatter chart as points alone, one per sample', () => {
    renderWith({ ...labelled, kind: 'scatter' });
    expect(host.querySelectorAll('.chart-series, .chart-area, .chart-bar, .chart-baseline')).toHaveLength(0);
    const groups = [...host.querySelectorAll<SVGGElement>('.chart-series-group')];
    expect(groups.map((group) => group.querySelectorAll('.chart-point').length)).toEqual([3, 2]);
    const scales = chartScales({ ...labelled, kind: 'scatter' });
    const first = groups[0].querySelector<SVGCircleElement>('.chart-point')!;
    expect(Number(first.getAttribute('cx'))).toBeCloseTo(scales.plot.left, 1);
    expect(Number(first.getAttribute('cy'))).toBeCloseTo(scales.valueAt(41.2), 1);
    expect(host.querySelector('.chart-legend__key')!.tagName.toLowerCase()).toBe('circle');
  });

  it('labels the x axis with the categories instead of numbers', () => {
    renderWith(labelled);
    const ticks = [...host.querySelectorAll<SVGTextElement>('.chart-grid text[text-anchor="middle"]')];
    expect(ticks.map((tick) => tick.textContent)).toEqual(['backend', 'frontend', 'skill']);
    const scales = chartScales(labelled);
    expect(Number(ticks[1].getAttribute('x'))).toBeCloseTo(scales.xAt(1), 1);
  });

  it('staggers category labels onto a second row when a row is too narrow for them', () => {
    const months = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
    renderWith({ labels: months, series: [{ name: 'A', values: months.map((_, index) => index) }] });
    const ticks = [...host.querySelectorAll<SVGTextElement>('.chart-grid__category')];
    expect(ticks).toHaveLength(12);
    const ys = ticks.map((tick) => Number(tick.getAttribute('y')));
    expect(ys[1] - ys[0]).toBe(CHART_TICK_ROW_HEIGHT);
    expect(ys[2]).toBe(ys[0]);
  });

  it('draws a bar chart with long labels on its side, the labels down the left', () => {
    const chart: ChartData = {
      kind: 'bar',
      labels: ['unit/transcriptSpeaker.test.ts', 'unit/displayRobustness.test.tsx', 'unit/debugPage.test.tsx', 'unit/documentViewport.test.tsx', 'unit/scenePage.test.tsx'],
      xLabel: 'TEST FILE',
      yLabel: 'MS',
      series: [{ name: 'MS', values: [467, 390, 330, 280, 260] }],
      marker: { x: 1 },
    };
    renderWith(chart);
    expect(host.querySelector('.chart-primitive')!.getAttribute('data-orientation')).toBe('horizontal');
    const scales = chartScales(chart);
    const labels = [...host.querySelectorAll<SVGTextElement>('.chart-grid__category')];
    // Each label whole, on its lines (a label past its column wraps).
    const drawn = (label: SVGTextElement) =>
      label.querySelectorAll('tspan').length > 0 ? [...label.querySelectorAll('tspan')].map((line) => line.textContent).join('') : label.textContent;
    expect(labels.map(drawn)).toEqual(chart.labels);
    for (const label of labels) {
      expect(label.getAttribute('text-anchor')).toBe('end');
      expect(Number(label.getAttribute('x'))).toBeLessThan(scales.plot.left);
    }
    // The value ticks run along the bottom, and the axis names follow their axes.
    const valueTicks = [...host.querySelectorAll<SVGTextElement>('.chart-grid text[text-anchor="middle"]')];
    expect(valueTicks.map((tick) => tick.textContent)).toEqual(['0', '200', '400', '600']);
    const axisLabels = [...host.querySelectorAll<SVGTextElement>('.chart-axis-label')].map((label) => label.textContent);
    expect(axisLabels).toEqual(['MS', 'TEST FILE']);
    // The bars run from the left, and the marker marks the named bar as a
    // bar: outlined, its value printed past its end.
    const bar = host.querySelector<SVGRectElement>('.chart-bar')!;
    expect(Number(bar.getAttribute('x'))).toBeCloseTo(scales.plot.left, 1);
    expect(host.querySelector('.chart-marker')).toBeNull();
    const callout = host.querySelector('.chart-callout')!;
    expect(callout.getAttribute('data-index')).toBe('1');
    const named = chartBars(chart, scales)[1];
    const outline = callout.querySelector('.chart-callout__outline')!;
    expect(Number(outline.getAttribute('x'))).toBeCloseTo(named.rect.left, 1);
    expect(Number(outline.getAttribute('width'))).toBeCloseTo(named.rect.right - named.rect.left, 1);
    const value = callout.querySelector('.chart-callout__value')!;
    expect(value.textContent).toBe('390');
    expect(Number(value.getAttribute('x'))).toBeGreaterThan(named.rect.right);
  });

  // A horizontal bar near the plot's end, too short to hold its value,
  // printed it past the plot inside the plot's clip: cut away (review).
  it("draws a marked bar's value outside the plot's clip, its outline inside it", () => {
    renderWith({ kind: 'bar', labels: ['a', 'b'], series: [{ name: 'S', values: [3, 1] }], marker: { x: 1 } });
    const callout = host.querySelector('.chart-callout')!;
    expect(callout.closest('[clip-path]')).toBeNull();
    expect(callout.querySelector('.chart-callout__outline')!.getAttribute('clip-path')).toMatch(/^url\(#/);
  });

  it('marks each bar a note names, as it marks its marker', () => {
    const chart: ChartData = { kind: 'bar', labels: ['a', 'b', 'c'], series: [{ name: 'S', values: [3, 1, 2] }] };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<ChartPrimitive data={chart} named={[{ x: 2 }]} />));
    const callouts = [...host.querySelectorAll('.chart-callout')];
    expect(callouts.map((callout) => callout.getAttribute('data-index'))).toEqual(['2']);
    expect(callouts[0].querySelector('.chart-callout__value')!.textContent).toBe('2');
  });

  it('never prints a value tick as negative zero', () => {
    // Both ends given: the axis is divided evenly, and the division that
    // lands on zero computes to a rounding error below it.
    renderWith({ kind: 'bar', labels: ['a', 'b'], yMin: -0.3, yMax: 0.6, series: [{ name: 'A', values: [0.5, -0.2] }] });
    const ticks = [...host.querySelectorAll<SVGTextElement>('.chart-grid text[text-anchor="end"]')].map((tick) => tick.textContent);
    expect(ticks).toContain('0.00');
    expect(ticks).not.toContain('-0.00');
  });

  it('labels a value axis the page chooses at round values, printed as such', () => {
    renderWith({ kind: 'bar', labels: ['a', 'b'], series: [{ name: 'A', values: [102.9, 1] }] });
    const ticks = [...host.querySelectorAll<SVGTextElement>('.chart-grid text[text-anchor="end"]')].map((tick) => tick.textContent);
    expect(ticks).toEqual(['0', '25', '50', '75', '100', '125']);
  });

  it('resolves every kind in with the same widening clip, and not at all under reduced motion', () => {
    for (const kind of ['bar', 'area', 'scatter'] as const) {
      renderWith({ ...labelled, kind });
      const groups = [...host.querySelectorAll<SVGGElement>('.chart-series-group')];
      expect(groups).toHaveLength(2);
      groups.forEach((group, index) => expect(group.getAttribute('clip-path')).toContain(`-trace-${index}`));
      expect(host.querySelectorAll('svg > defs > clipPath > rect')).toHaveLength(3);
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe('chart kinds keep the line chart as it was', () => {
  it('anchors the axis names where they have always been, on every kind', () => {
    for (const kind of ['line', 'bar', 'area', 'scatter'] as const) {
      renderWith({ kind, xLabel: 'EPOCH', yLabel: 'LOSS', series: [{ name: 'A', values: [1, 2, 3] }] });
      const labels = [...host.querySelectorAll<SVGTextElement>('.chart-axis-label')];
      expect(labels[0].getAttribute('x')).toBe('500');
      expect(labels[1].getAttribute('transform')).toBe('translate(17 250) rotate(-90)');
      act(() => root.unmount());
      host.remove();
    }
  });

  it('still spreads a numeric series edge to edge when its x domain is not positive', () => {
    renderWith({ series: [{ name: 'A', values: [1, 2, 3] }], xMax: 0 });
    const d = host.querySelector('.chart-series')!.getAttribute('d')!;
    const xs = [...d.matchAll(/[ML] ([\d.]+) /g)].map((match) => Number(match[1]));
    expect(xs[0]).toBeCloseTo(74);
    expect(xs[2]).toBeCloseTo(1000 - 28);
    expect(host.querySelector('.chart-marker')).toBeNull();
  });

  // A label held inside the viewBox at the plot's edge moves toward its
  // neighbour; the layout must count that move when it decides a row fits,
  // or the two overlap (five 20-character service names did).
  it('keeps an edge label it holds inside the viewBox clear of its neighbour on the row', () => {
    const labels = ['checkout-service p95', 'inventory-svc p95 ms', 'payments-gateway p95', 'search-frontend p95x', 'shipping-quotes p95x'];
    renderWith({ labels, series: [{ name: 'P95', values: [120, 180, 90, 140, 160] }] });
    const ticks = [...host.querySelectorAll<SVGTextElement>('.chart-grid__category')].map((tick) => {
      const x = Number(tick.getAttribute('x'));
      const half = (tick.textContent!.length * CHART_TICK_CHAR_ADVANCE) / 2;
      return { y: Number(tick.getAttribute('y')), left: x - half, right: x + half };
    });
    expect(ticks).toHaveLength(labels.length);
    for (const row of new Set(ticks.map((tick) => tick.y))) {
      const onRow = ticks.filter((tick) => tick.y === row).sort((a, b) => a.left - b.left);
      for (let index = 1; index < onRow.length; index += 1) {
        expect(onRow[index].left - onRow[index - 1].right).toBeGreaterThanOrEqual(CHART_TICK_GAP);
      }
    }
    for (const tick of ticks) {
      expect(tick.left).toBeGreaterThanOrEqual(0);
      expect(tick.right).toBeLessThanOrEqual(1000);
    }
  });

  it('holds the last category label inside the viewBox', () => {
    const labels = ['ONE', 'TWO', 'A RATHER LONG LAST LABEL'];
    renderWith({ labels, series: [{ name: 'A', values: [1, 2, 3] }] });
    const last = [...host.querySelectorAll<SVGTextElement>('.chart-grid__category')].pop()!;
    const half = (labels[2].length * CHART_TICK_CHAR_ADVANCE) / 2;
    expect(Number(last.getAttribute('x')) + half).toBeLessThanOrEqual(1000);
    expect(Number(last.getAttribute('x'))).toBeLessThan(1000 - 28);
  });
});

// The chart's frame is its slot's to decide (chartGeometry's chartFrame):
// a phone's slot gets a frame of its own shape, not the desktop canvas drawn
// at a third of its size.
describe('chart frame', () => {
  function renderInSlot(chart: ChartData, slot: { width: number; height: number }) {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chart-primitive') ? slot.width : 0;
    });
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chart-primitive') ? slot.height : 0;
    });
    try {
      renderWith(chart);
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
    return host.querySelector('.chart-primitive > svg, .chart-primitive__canvas > svg')!;
  }
  const suite: ChartData = {
    kind: 'bar',
    labels: ['backend', 'frontend unit', 'frontend visual', 'host agent', 'skill', 'hygiene'],
    xLabel: 'PACKAGE',
    yLabel: 'SECONDS',
    series: [{ name: 'THIS RUN', values: [41.8, 3.3, 96.4, 6.1, 0.3, 0.4] }],
  };

  it('keeps the approved canvas in a landscape slot', () => {
    const svg = renderInSlot(suite, { width: 937, height: 561 });
    expect(svg.getAttribute('viewBox')).toBe('0 0 1000 500');
  });

  it("recomposes for a phone's slot, its plot filling the slot and its bars turned on their side", () => {
    const svg = renderInSlot(suite, { width: 342, height: 393 });
    const width = Math.floor(342 / CHART_READABLE_SCALE);
    const height = Math.floor(393 / CHART_READABLE_SCALE);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${width} ${height}`);
    // The labels no longer fit a row under bars this narrow, so the bars run across.
    expect(host.querySelector('.chart-primitive')!.getAttribute('data-orientation')).toBe('horizontal');
    const scales = chartScales(suite, { width, height });
    // The axis names sit at the frame's own edges.
    const names = [...host.querySelectorAll<SVGTextElement>('.chart-axis-label')];
    expect(Number(names[0].getAttribute('y'))).toBe(height - 2);
    expect(Number(names[0].getAttribute('x'))).toBe(width / 2);
    const bar = host.querySelector<SVGRectElement>('.chart-bar')!;
    expect(Number(bar.getAttribute('x'))).toBeCloseTo(scales.plot.left, 1);
    expect(scales.plot.right).toBe(width - 28);
  });

  it('draws a bar chart too long for its slot on its side at its least height, to scroll in the slot, its value axis over the rows', () => {
    // Sixty services on a phone's stage: too many for a row each in 560px.
    const sixty: ChartData = {
      kind: 'bar',
      labels: Array.from({ length: 60 }, (_, index) => `service-${String(index).padStart(2, '0')}`),
      series: [{ name: 'THIS WEEK', values: Array.from({ length: 60 }, (_, index) => 10 + ((index * 37) % 80)) }],
    };
    const slot = { width: 358, height: 560 };
    renderInSlot(sixty, slot);
    const chart = host.querySelector('.chart-primitive')!;
    expect(chart.className).toContain('chart-primitive--scrolls');
    expect(chart.getAttribute('data-orientation')).toBe('horizontal');
    const canvas = host.querySelector<HTMLElement>('.chart-primitive__canvas')!;
    expect(canvas.style.height).toBe(`${chartScrollHeight(sixty, slot)}px`);
    expect(host.querySelectorAll('.chart-primitive__canvas > svg .chart-grid__category')).toHaveLength(60);
    // The value axis's labels, pinned over the rows, are its own.
    const axis = [...host.querySelectorAll('.list-viewport__head .chart-primitive__axis text')].map((text) => text.textContent);
    const ticks = [...host.querySelectorAll('.chart-primitive__canvas > svg .chart-grid > g > text')].map((text) => text.textContent);
    expect(axis.length).toBeGreaterThan(1);
    expect(ticks.slice(0, axis.length)).toEqual(axis);
    // A chart whose rows fit its slot draws in it, as before.
    act(() => root.unmount());
    host.remove();
    renderInSlot(sixty, { width: 358, height: 1200 });
    expect(host.querySelector('.chart-primitive')!.className).not.toContain('chart-primitive--scrolls');
  });
});

describe('chart category labels down the left', () => {
  it('wraps a long label onto lines centred on its row, its whole name kept', () => {
    const labels = ['apps/backend/tests/test_visual_protocol.rs', 'apps/frontend/tests/unit/notePlacement.test.ts', 'skills/switchboard/tests/test_display.py'];
    renderWith({ kind: 'bar', labels, series: [{ name: 'S', values: [3, 2, 1] }] });
    const scales = chartScales({ kind: 'bar', labels, series: [{ name: 'S', values: [3, 2, 1] }] });
    const texts = [...host.querySelectorAll<SVGTextElement>('.chart-grid__category')];
    expect(texts).toHaveLength(3);
    texts.forEach((text, index) => {
      const lines = [...text.querySelectorAll('tspan')];
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.map((line) => line.textContent).join('')).toBe(labels[index]);
      expect(text.querySelector('title')!.textContent).toBe(labels[index]);
      const ys = lines.map((line) => Number(line.getAttribute('y')));
      const middle = (ys[0] + ys[ys.length - 1]) / 2;
      expect(middle).toBeCloseTo(scales.xAt(index) + 4, 6);
    });
  });
});
