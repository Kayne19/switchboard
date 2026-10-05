// A bar chart whose labels do not fit under its bars is laid on its side,
// a labelled row per category, as long as its rows fit the plot; a phone's
// slot fits some thirty. Past that the labels were thinned to every n-th
// and the bars could not be named. Such a chart now says the height it
// would give every category a row in (chartLeastHeight), and on a portrait
// stage takes the stage's height for it (stageFold.ts).
import { describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { CHART_PAD, CHART_READABLE_SCALE, CHART_TICK_ROW_HEIGHT, chartCategoryLayout, chartFrame, chartLeastHeight } from '../../src/primitives/chartGeometry';

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
