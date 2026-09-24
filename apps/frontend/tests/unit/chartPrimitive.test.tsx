// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { ChartPrimitive, chartSeriesColor, chartXTicks, type ChartNoteCard } from '../../src/primitives/ChartPrimitive';

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


// The leader is a tapered wedge: its first and last points are one side of
// it, the middle two the other, so the midpoints of its ends are where it
// leaves the card and where it meets the line.
function leaderGeometry(root: ParentNode) {
  const polygon = root.querySelector<SVGPolygonElement>('.chart-pointer__leader');
  if (!polygon) return null;
  const points = polygon.getAttribute('points')!.split(' ').map((pair) => pair.split(',').map(Number));
  const [a, b, c, d] = points;
  return {
    start: { x: (a[0] + d[0]) / 2, y: (a[1] + d[1]) / 2 },
    end: { x: (b[0] + c[0]) / 2, y: (b[1] + c[1]) / 2 },
    startWidth: Math.hypot(a[0] - d[0], a[1] - d[1]),
    endWidth: Math.hypot(b[0] - c[0], b[1] - c[1]),
  };
}

type Annotation = { x?: number; series?: string; card?: ChartNoteCard };

function renderWith(chart: ChartData, annotation?: Annotation) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ChartPrimitive data={chart} annotation={annotation} />));
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

describe('chart pointer', () => {
  it('draws a leader reaching the real series point when anchor has x', () => {
    renderWith(data, { x: 1, series: 'GAMMA' });

    expect(host.querySelector('.chart-pointer')).not.toBeNull();
    const leader = leaderGeometry(host)!;
    // GAMMA runs 3 -> 4 across x 0 -> 1 on a 1..6 scale.
    expect(leader.end.x).toBeCloseTo(1000 - 28, 1);
    expect(leader.end.y).toBeCloseTo(34 + (1 - (4 - 1) / (6 - 1)) * plotHeight, 1);
    // Unmeasured, it drops straight from the plot top.
    expect(leader.start.x).toBeCloseTo(leader.end.x, 1);
    expect(leader.start.y).toBeCloseTo(34, 1);
  });

  it('marks the point with the leader alone, not a dot of its own', () => {
    renderWith(data, { x: 1, series: 'GAMMA' });
    expect(host.querySelector('.chart-pointer circle')).toBeNull();
    expect(host.querySelector('.chart-pointer__leader')?.getAttribute('fill')).toMatch(/^url\(#.+-leader\)$/);
  });

  it('draws no pointer when anchor does not have x', () => {
    renderWith(data, { series: 'GAMMA' });
    expect(host.querySelector('.chart-pointer')).toBeNull();
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
  const card = (left: number, right: number, bottom: number, unitsPerPx = 1): ChartNoteCard => ({ left, right, bottom, unitsPerPx });

  it('keeps the marker point when the annotation points elsewhere', () => {
    renderWith(markerData, { x: 1, series: 'VALID' });
    expect(host.querySelector('.chart-pointer__leader')).not.toBeNull();
    expect(host.querySelector('.chart-marker__point')).not.toBeNull();
  });

  it('keeps the marker point when the annotation lands on it, and ends the leader there', () => {
    renderWith(markerData, { x: 3, series: 'LOSS' });
    const marker = host.querySelector<SVGCircleElement>('.chart-marker__point');
    expect(marker).not.toBeNull();
    const leader = leaderGeometry(host)!;
    expect(leader.end.x).toBeCloseTo(Number(marker!.getAttribute('cx')), 1);
    expect(leader.end.y).toBeCloseTo(Number(marker!.getAttribute('cy')), 1);
  });

  it('leaves the card straight above the point when the card spans it', () => {
    renderWith(markerData, { x: 1, series: 'VALID', card: card(200, 600, 90) });
    const leader = leaderGeometry(host)!;
    expect(leader.start.x).toBeCloseTo(74 + plotWidth / 3, 1);
    expect(leader.start.y).toBeCloseTo(90, 1);
    expect(leader.end.x).toBeCloseTo(74 + plotWidth / 3, 1);
  });

  it('leaves the card from inside its nearest corner when the point is beyond it', () => {
    renderWith(markerData, { x: 3, series: 'VALID', card: card(200, 600, 90, 2) });
    const leader = leaderGeometry(host)!;
    // 14 px in from the right edge, at 2 units per px.
    expect(leader.start.x).toBeCloseTo(600 - 28, 1);
    expect(leader.start.y).toBeCloseTo(90, 1);
    expect(leader.end.x).toBeCloseTo(1000 - 28, 1);
  });

  it('tapers from the card to the point at the same screen width at any drawn size', () => {
    renderWith(markerData, { x: 1, series: 'VALID', card: card(200, 600, 90, 1) });
    const small = leaderGeometry(host)!;
    act(() => root.unmount());
    host.remove();
    renderWith(markerData, { x: 1, series: 'VALID', card: card(200, 600, 90, 2) });
    const large = leaderGeometry(host)!;
    expect(small.startWidth).toBeGreaterThan(small.endWidth);
    expect(large.startWidth).toBeCloseTo(small.startWidth * 2, 1);
    expect(large.endWidth).toBeCloseTo(small.endWidth * 2, 1);
  });

  it('lands the pointer on the drawn segment when x falls between samples', () => {
    // Samples at x = 0, 2, 4, 6; x = 1 is halfway along the first segment,
    // which the path draws straight from 0 to 6.
    renderWith({ series: [{ name: 'SAW', values: [0, 6, 0, 6] }], xMax: 6, yMin: 0, yMax: 6 }, { x: 1, series: 'SAW' });
    const leader = leaderGeometry(host)!;
    expect(leader.end.x).toBeCloseTo(74 + plotWidth / 6, 1);
    expect(leader.end.y).toBeCloseTo(34 + plotHeight / 2, 1);
  });

  it('holds an out-of-range x at the end of the plot instead of drawing off it', () => {
    renderWith(markerData, { x: 9, series: 'VALID' });
    const leader = leaderGeometry(host)!;
    const valid = markerData.series[1].values;
    expect(leader.end.x).toBeCloseTo(1000 - 28, 1);
    // The y is the last sample's, the same point the path ends on.
    expect(leader.end.y).toBeCloseTo(34 + (1 - (valid[valid.length - 1] - 1) / (4 - 1)) * plotHeight, 1);
  });

  it('draws the leader outside the plot clip so it reaches a card above the plot', () => {
    renderWith(markerData, { x: 1, series: 'VALID', card: card(200, 600, -40) });
    const leader = leaderGeometry(host)!;
    expect(leader.start.y).toBeCloseTo(-40, 1);
    expect(host.querySelector('.chart-pointer__leader')?.closest('[clip-path]')).toBeNull();
  });
});
