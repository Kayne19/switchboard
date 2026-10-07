// A bar chart whose labels do not fit under its bars is laid on its side,
// a labelled row per category, as long as its rows fit the plot; a phone's
// slot fits some thirty. Past that the labels were thinned to every n-th
// and the bars could not be named. Such a chart knows the height it would
// give every category a row in (chartLeastHeight), and in a slot taller
// than it is wide is drawn at that height, to scroll (chartScrollHeight).
import { describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { CHART_PAD, CHART_READABLE_SCALE, CHART_TICK_ROW_HEIGHT, chartCategoryLayout, chartFrame, chartLeastHeight, chartScrollHeight } from '../../src/primitives/chartGeometry';

const services = (count: number): ChartData => ({
  kind: 'bar',
  labels: Array.from({ length: count }, (_, index) => `service-${String(index).padStart(2, '0')}`),
  series: [{ name: 'THIS WEEK', values: Array.from({ length: count }, (_, index) => 10 + index) }],
});

describe('the height a bar chart asks for a row per category', () => {
  it('asks nothing of a chart that is not bars, has no labels, or whose labels fit under its bars', () => {
    expect(chartLeastHeight({ ...services(45), kind: 'line' }, 358)).toBeNull();
    expect(chartLeastHeight({ series: [{ name: 'S', values: [1, 2, 3] }] }, 358)).toBeNull();
    expect(chartLeastHeight({ kind: 'bar', labels: ['a', 'b', 'c'], series: [{ name: 'S', values: [1, 2, 3] }] }, 358)).toBeNull();
  });

  it('is a row per category, with the plot\'s padding and legend, at the readable scale', () => {
    const least = chartLeastHeight(services(45), 358)!;
    // One legend row over a bar chart's plot.
    const units = CHART_PAD.top + 20 + 45 * CHART_TICK_ROW_HEIGHT + CHART_PAD.bottom;
    expect(least).toBeCloseTo(units * CHART_READABLE_SCALE, 5);
  });

  it('is a slot in which the chart does lie on its side, a row per category, and a slot shorter is not', () => {
    const data = services(45);
    const least = chartLeastHeight(data, 358)!;
    const tall = chartFrame({ width: 358, height: Math.ceil(least) + 1 });
    expect(chartCategoryLayout(data, tall).horizontal).toBe(true);
    expect(chartCategoryLayout(data, tall).ticks).toHaveLength(45);
    const short = chartFrame({ width: 358, height: Math.floor(least) - 40 });
    expect(chartCategoryLayout(data, short).horizontal).toBe(false);
  });

  it('is within a phone\'s slot for thirty categories, past it for forty-five', () => {
    // The diagram slot on a 390x844 phone is about 470 px tall inside its frame.
    expect(chartLeastHeight(services(30), 358)!).toBeLessThan(470);
    expect(chartLeastHeight(services(45), 358)!).toBeGreaterThan(470);
  });
});

// Past its slot's height the bars stood upright again, a few of sixty names
// under bars a few pixels wide. In a slot taller than it is wide such a
// chart is drawn on its side at its least height, and scrolls in the slot.
describe('a bar chart too long for its slot', () => {
  it('is drawn at its least height, to scroll, in a slot taller than it is wide', () => {
    // A tall slot: 358 px across, some 560 tall.
    const data = services(60);
    expect(chartScrollHeight(data, { width: 358, height: 560 })).toBe(Math.ceil(chartLeastHeight(data, 358)!));
    // On its canvas the chart lies on its side, every category a row.
    const canvas = chartFrame({ width: 358, height: chartScrollHeight(data, { width: 358, height: 560 })! });
    const layout = chartCategoryLayout(data, canvas);
    expect(layout.horizontal).toBe(true);
    expect(layout.ticks).toHaveLength(60);
  });

  it('is drawn in its slot where its rows fit, where the slot is wide, or where every label shows upright', () => {
    // The rows fit: on its side in the slot, no scroll.
    expect(chartScrollHeight(services(45), { width: 358, height: 600 })).toBeNull();
    // A wide slot stands the bars upright, thinned, the whole chart in view.
    expect(chartScrollHeight(services(60), { width: 1300, height: 560 })).toBeNull();
    // Labels short enough to stand under their bars.
    const short: ChartData = { kind: 'bar', labels: Array.from({ length: 60 }, (_, index) => String(index)), series: [{ name: 'S', values: Array.from({ length: 60 }, () => 1) }] };
    expect(chartScrollHeight(short, { width: 1300, height: 560 })).toBeNull();
    // Not bars, or not measured.
    expect(chartScrollHeight({ ...services(60), kind: 'line' }, { width: 358, height: 560 })).toBeNull();
    expect(chartScrollHeight(services(60), { width: 0, height: 0 })).toBeNull();
  });
});
