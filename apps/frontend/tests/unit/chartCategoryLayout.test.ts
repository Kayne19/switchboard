import { describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import {
  CHART_CATEGORY_PAD_MAX,
  CHART_LEGEND_ROW_HEIGHT,
  CHART_MARKER_RADIUS,
  CHART_MARKER_STROKE,
  CHART_PAD,
  CHART_POINT_RADIUS,
  CHART_TICK_CHAR_ADVANCE,
  CHART_TICK_GAP,
  CHART_TICK_ROW_HEIGHT,
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  chartAxisBoxes,
  chartBars,
  chartCategoryLayout,
  chartClip,
  chartLegendBox,
  chartObstacles,
  chartPad,
  chartScales,
  chartSeriesPoint,
} from '../../src/primitives/chartGeometry';

const plotWidth = CHART_VIEW_WIDTH - CHART_PAD.left - CHART_PAD.right;
const plotHeight = CHART_VIEW_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;

function labelled(count: number, length: number, kind: ChartData['kind'] = 'line'): ChartData {
  return {
    kind,
    labels: Array.from({ length: count }, (_, index) => `${index}`.padEnd(length, 'x')),
    series: [{ name: 'A', values: Array.from({ length: count }, (_, index) => index + 1) }],
  };
}

// How the category labels are laid along the axis is decided from the
// geometry alone: the plot's width against the labels' measured width.
describe('chart category layout', () => {
  it('draws every label on one row when a row of them fits the plot', () => {
    const layout = chartCategoryLayout(labelled(6, 8));
    expect(layout.horizontal).toBe(false);
    expect(layout.rows).toBe(1);
    expect(layout.step).toBe(1);
    expect(layout.ticks.map((tick) => tick.row)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(layout.ticks.map((tick) => tick.text)).toEqual(labelled(6, 8).labels);
  });

  it('staggers the labels onto two rows when one row is too narrow for them', () => {
    // Twelve 10-character labels spread edge to edge: a slot is an
    // eleventh of the width, under a label and its gap, but two slots are
    // over them.
    const layout = chartCategoryLayout(labelled(12, 10));
    const slot = plotWidth / 11;
    expect(10 * CHART_TICK_CHAR_ADVANCE + CHART_TICK_GAP).toBeGreaterThan(slot);
    expect(10 * CHART_TICK_CHAR_ADVANCE + CHART_TICK_GAP).toBeLessThan(2 * slot);
    expect(layout.horizontal).toBe(false);
    expect(layout.rows).toBe(2);
    expect(layout.step).toBe(1);
    expect(layout.ticks).toHaveLength(12);
    expect(layout.ticks.map((tick) => tick.row)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    // The plot gives the second row its room.
    expect(chartPad(labelled(12, 10)).bottom).toBe(CHART_PAD.bottom + CHART_TICK_ROW_HEIGHT);
  });

  it('thins the labels to every n-th when even two rows cannot hold them', () => {
    const layout = chartCategoryLayout(labelled(40, 10));
    expect(layout.horizontal).toBe(false);
    expect(layout.step).toBeGreaterThan(1);
    expect(layout.ticks.length).toBeLessThan(40);
    expect(layout.ticks.map((tick) => tick.index)).toEqual(
      Array.from({ length: Math.ceil(40 / layout.step) }, (_, index) => index * layout.step),
    );
    // The drawn labels still clear each other: a label's width fits the
    // slots between one drawn tick and the next, on its row.
    const slot = plotWidth / 39;
    expect(10 * CHART_TICK_CHAR_ADVANCE + CHART_TICK_GAP).toBeLessThanOrEqual(layout.step * layout.rows * slot);
  });

  it('turns a bar chart on its side when its labels do not fit a row but fit as rows', () => {
    const chart = labelled(7, 24, 'bar');
    expect(24 * CHART_TICK_CHAR_ADVANCE + CHART_TICK_GAP).toBeGreaterThan(plotWidth / 7);
    const layout = chartCategoryLayout(chart);
    expect(layout.horizontal).toBe(true);
    expect(layout.step).toBe(1);
    expect(layout.ticks).toHaveLength(7);
    expect(layout.ticks.every((tick) => !tick.truncated)).toBe(true);
    // The plot moves right to fit the labels, up to the cap.
    const pad = chartPad(chart);
    expect(pad.left).toBeGreaterThan(CHART_PAD.left);
    expect(pad.left).toBeLessThanOrEqual(CHART_CATEGORY_PAD_MAX);
    expect(pad.left).toBeGreaterThanOrEqual(24 * CHART_TICK_CHAR_ADVANCE + 14);
  });

  it('truncates a horizontal bar chart label past the room the plot gives it', () => {
    const chart = labelled(3, 80, 'bar');
    const layout = chartCategoryLayout(chart);
    expect(layout.horizontal).toBe(true);
    expect(layout.ticks[0].truncated).toBe(true);
    expect(layout.ticks[0].text.endsWith('…')).toBe(true);
    // The plot moves right only as far as the truncated label needs, never past the cap.
    const pad = chartPad(chart);
    expect(pad.left).toBeLessThanOrEqual(CHART_CATEGORY_PAD_MAX);
    expect(pad.left).toBeGreaterThanOrEqual(layout.ticks[0].text.length * CHART_TICK_CHAR_ADVANCE + 14);
    expect(layout.ticks[0].text.length * CHART_TICK_CHAR_ADVANCE).toBeLessThanOrEqual(CHART_CATEGORY_PAD_MAX - 40);
  });

  it('keeps a bar chart upright and thins its labels when a row per category would not fit either', () => {
    const chart = labelled(60, 20, 'bar');
    expect(60 * CHART_TICK_ROW_HEIGHT).toBeGreaterThan(plotHeight);
    const layout = chartCategoryLayout(chart);
    expect(layout.horizontal).toBe(false);
    expect(layout.step).toBeGreaterThan(1);
    expect(chartPad(chart).left).toBe(CHART_PAD.left);
  });

  it('names a bar chart without labels by its value indices', () => {
    const layout = chartCategoryLayout({ kind: 'bar', series: [{ name: 'A', values: [3, 1, 2] }] });
    expect(layout.categories).toEqual(['0', '1', '2']);
    expect(layout.ticks.map((tick) => tick.text)).toEqual(['0', '1', '2']);
    expect(chartCategoryLayout({ series: [{ name: 'A', values: [3, 1, 2] }] }).categories).toBeUndefined();
  });

  it('starts a bar chart plot below the legend instead of under it', () => {
    const line: ChartData = { series: [{ name: 'A', values: [1, 2] }] };
    expect(chartPad(line).top).toBe(CHART_PAD.top);
    expect(chartPad({ ...line, kind: 'bar' }).top).toBe(CHART_PAD.top + CHART_LEGEND_ROW_HEIGHT);
  });
});

describe('chart bars', () => {
  const chart: ChartData = {
    kind: 'bar',
    labels: ['a', 'b', 'c'],
    series: [
      { name: 'ONE', values: [4, 2, 3] },
      { name: 'TWO', values: [1, 3] },
    ],
  };

  it('groups the bars per category across the series, in series order', () => {
    const scales = chartScales(chart);
    const bars = chartBars(chart, scales);
    expect(bars.map((bar) => [bar.series, bar.index])).toEqual([[0, 0], [0, 1], [0, 2], [1, 0], [1, 1]]);
    const band = (scales.plot.right - scales.plot.left) / 3;
    expect(scales.band).toBeCloseTo(band);
    for (const bar of bars) {
      // Inside its category's band, and the second series to the right of the first.
      const bandLeft = scales.plot.left + bar.index * band;
      expect(bar.rect.left).toBeGreaterThanOrEqual(bandLeft);
      expect(bar.rect.right).toBeLessThanOrEqual(bandLeft + band);
      if (bar.series === 1) {
        const first = bars.find((other) => other.series === 0 && other.index === bar.index)!;
        expect(bar.rect.left).toBeGreaterThanOrEqual(first.rect.right);
      }
    }
  });

  it('rises from zero when the y domain spans it, and the domain reaches zero on its own', () => {
    const scales = chartScales(chart);
    expect(scales.yMin).toBe(0);
    expect(scales.baseline).toBe(0);
    const bars = chartBars(chart, scales);
    for (const bar of bars) {
      expect(bar.rect.bottom).toBeCloseTo(scales.plot.bottom);
      expect(bar.rect.top).toBeCloseTo(scales.valueAt(bar.value));
      expect(bar.end).toEqual({ x: (bar.rect.left + bar.rect.right) / 2, y: bar.rect.top });
    }
  });

  it('rises from the nearest end of a y domain that excludes zero', () => {
    const positive = chartScales({ ...chart, yMin: 1, yMax: 5 });
    expect(positive.baseline).toBe(1);
    const negative = chartScales({ ...chart, yMin: -9, yMax: -4, series: [{ name: 'N', values: [-5, -8] }] });
    expect(negative.baseline).toBe(-4);
    // A negative bar hangs from the baseline.
    const bars = chartBars({ ...chart, series: [{ name: 'N', values: [-5, 8] }] });
    expect(bars[0].rect.top).toBeCloseTo(chartScales({ ...chart, series: [{ name: 'N', values: [-5, 8] }] }).valueAt(0));
    expect(bars[0].end.y).toBe(bars[0].rect.bottom);
  });

  it('runs across the chart from the left when drawn horizontally', () => {
    const wide = labelled(5, 40, 'bar');
    const scales = chartScales(wide);
    expect(scales.horizontal).toBe(true);
    const bars = chartBars(wide, scales);
    for (const bar of bars) {
      expect(bar.rect.left).toBeCloseTo(scales.plot.left);
      expect(bar.rect.right).toBeCloseTo(scales.valueAt(bar.value));
      expect(bar.end).toEqual({ x: bar.rect.right, y: (bar.rect.top + bar.rect.bottom) / 2 });
      // The first category is the top row.
      expect(bar.rect.top).toBeGreaterThanOrEqual(scales.plot.top + bar.index * scales.band);
    }
  });
});

// What a note over the chart keeps clear of, as the chart draws it: a bar or
// a point is an area, so it is a mark, not the outline round it.
describe('chart obstacles', () => {
  const bars: ChartData = {
    kind: 'bar',
    labels: ['a', 'b', 'c'],
    series: [
      { name: 'ONE', values: [4, 2, 3] },
      { name: 'TWO', values: [1, 3] },
    ],
  };

  it('keeps a note off each bar as the area it fills, not its outline', () => {
    const obstacles = chartObstacles(bars);
    expect(obstacles.marks).toEqual(chartBars(bars).map((bar) => bar.rect));
    expect(obstacles.lines).toEqual([]);
    expect(obstacles.fills).toEqual([]);
  });

  it('cuts a bar that runs past the domain to the plot, as the clip draws it', () => {
    const scales = chartScales({ ...bars, yMax: 3 });
    const tallest = chartObstacles({ ...bars, yMax: 3 }, scales).marks[0];
    expect(tallest.top).toBeCloseTo(scales.plot.top);
    expect(tallest.bottom).toBeCloseTo(scales.plot.bottom);
  });

  it('marks the marker ring where it is drawn, stroke and all', () => {
    const marked = { ...bars, marker: { x: 1, series: 'TWO' } };
    const scales = chartScales(marked);
    const point = chartSeriesPoint(marked, 1, 'TWO', scales)!;
    const reach = CHART_MARKER_RADIUS + CHART_MARKER_STROKE / 2;
    expect(chartObstacles(marked, scales).marks.at(-1)).toEqual({ left: point.x - reach, top: point.y - reach, right: point.x + reach, bottom: point.y + reach });
  });

  it("cuts the marker ring with the clip the chart draws it in, a scatter's wider one included", () => {
    // The marker on the last point, on the plot's right edge.
    const scatter: ChartData = { kind: 'scatter', xMax: 2, series: [{ name: 'A', values: [1, 3, 2] }], marker: { x: 2 } };
    const scales = chartScales(scatter);
    const clip = chartClip(scales);
    expect(clip.right).toBe(scales.plot.right + CHART_POINT_RADIUS + 1);
    const ring = chartObstacles(scatter, scales).marks.at(-1)!;
    expect(ring.right).toBe(clip.right);
    expect(ring.right).toBeGreaterThan(scales.plot.right);
    expect(chartClip(chartScales(bars))).toEqual(chartScales(bars).plot);
  });

  it('gives each scatter point its drawn box, and a line chart its lines', () => {
    const series = [{ name: 'A', values: [1, 3, 2] }];
    const scatter = chartScales({ kind: 'scatter', xMax: 2, series });
    const marks = chartObstacles({ kind: 'scatter', xMax: 2, series }, scatter).marks;
    expect(marks).toHaveLength(3);
    const middle = scatter.pointAt(1, 3);
    expect(marks[1]).toEqual({
      left: middle.x - CHART_POINT_RADIUS,
      top: middle.y - CHART_POINT_RADIUS,
      right: middle.x + CHART_POINT_RADIUS,
      bottom: middle.y + CHART_POINT_RADIUS,
    });
    const line = chartScales({ xMax: 2, series });
    const obstacles = chartObstacles({ xMax: 2, series }, line);
    expect(obstacles.marks).toEqual([]);
    expect(obstacles.lines).toEqual([[line.pointAt(0, 1), line.pointAt(1, 3), line.pointAt(2, 2)]]);
  });

  it('fills an area chart between its line and the baseline, in two triangles where the line crosses it', () => {
    const area: ChartData = { kind: 'area', labels: ['a', 'b', 'c'], series: [{ name: 'A', values: [2, -2, -1] }] };
    const scales = chartScales(area);
    const { fills, lines } = chartObstacles(area, scales);
    expect(lines).toHaveLength(1);
    const base = scales.valueAt(0);
    // a to b crosses the baseline halfway: two triangles; b to c stays below it: one piece.
    expect(fills.map((piece) => piece.length)).toEqual([3, 3, 4]);
    const shoelace = (piece: Array<{ x: number; y: number }>) =>
      Math.abs(piece.reduce((sum, p, index) => sum + p.x * piece[(index + 1) % piece.length].y - piece[(index + 1) % piece.length].x * p.y, 0)) / 2;
    const step = scales.xAt(1) - scales.xAt(0);
    const unit = Math.abs(scales.valueAt(1) - base);
    expect(shoelace(fills[0]) + shoelace(fills[1])).toBeCloseTo((step / 2) * 2 * unit, 6);
    expect(shoelace(fills[2])).toBeCloseTo(step * 1.5 * unit, 6);
    for (const piece of fills) expect(piece.some((p) => Math.abs(p.y - base) < 1e-9)).toBe(true);
  });

  it('keeps the legend and the axes\' labels in view', () => {
    const scales = chartScales(bars);
    expect(chartObstacles(bars, scales).labels).toEqual([chartLegendBox(bars), ...chartAxisBoxes(scales.plot)]);
  });
});

describe('chart series point on a labelled chart', () => {
  it('names a label index, not a share of the numeric domain', () => {
    const chart: ChartData = { labels: ['a', 'b', 'c', 'd'], xMax: 400, series: [{ name: 'A', values: [1, 3, 2, 4] }] };
    const scales = chartScales(chart);
    expect(scales.xMax).toBe(3);
    const point = chartSeriesPoint(chart, 1, 'A', scales)!;
    expect(point.x).toBeCloseTo(scales.plot.left + (1 / 3) * (scales.plot.right - scales.plot.left));
    expect(point.y).toBeCloseTo(scales.valueAt(3));
    // Halfway between two labels lies on the drawn segment.
    expect(chartSeriesPoint(chart, 1.5, 'A', scales)!.y).toBeCloseTo(scales.valueAt(2.5));
  });

  it('holds a series shorter than the labels at its own last sample', () => {
    const chart: ChartData = { labels: ['a', 'b', 'c', 'd'], series: [{ name: 'A', values: [1, 3] }] };
    const scales = chartScales(chart);
    expect(chartSeriesPoint(chart, 3, 'A', scales)).toEqual(chartSeriesPoint(chart, 1, 'A', scales));
  });

  it('reaches a point on a chart with a single label', () => {
    const chart: ChartData = { labels: ['only'], series: [{ name: 'A', values: [2] }] };
    const scales = chartScales(chart);
    expect(chartSeriesPoint(chart, 0, 'A', scales)).toEqual({ x: scales.plot.left, y: scales.valueAt(2) });
  });

  it('reaches the far end of the nearest bar on a bar chart', () => {
    const chart: ChartData = { kind: 'bar', labels: ['a', 'b', 'c'], series: [{ name: 'ONE', values: [4, 2, 3] }, { name: 'TWO', values: [1, 3, 2] }] };
    const scales = chartScales(chart);
    const bars = chartBars(chart, scales);
    expect(chartSeriesPoint(chart, 1.4, 'TWO', scales)).toEqual(bars.find((bar) => bar.series === 1 && bar.index === 1)!.end);
    expect(chartSeriesPoint(chart, 9, 'ONE', scales)).toEqual(bars.find((bar) => bar.series === 0 && bar.index === 2)!.end);
  });

  // A line's point is held inside the plot, as its clip holds the line. A
  // bar that runs past an explicit end of the domain is clipped at the
  // plot's edge too, so its marker and a note's leader meet it there; left
  // past the edge, the marker was clipped away and a leader ran off the plot.
  it('holds the end of a bar that runs past the domain at the plot edge', () => {
    const charts: ChartData[] = [
      { kind: 'bar', labels: ['a', 'b', 'c'], yMax: 50, series: [{ name: 'S', values: [20, 80, 30] }] },
      { kind: 'bar', labels: ['a', 'b', 'c'], yMin: -10, series: [{ name: 'S', values: [20, -40, 30] }] },
      { ...labelled(5, 40, 'bar'), yMax: 2 },
    ];
    for (const chart of charts) {
      const scales = chartScales(chart);
      const { plot } = scales;
      for (const bar of chartBars(chart, scales)) {
        expect(bar.end.x).toBeGreaterThanOrEqual(plot.left - 1e-9);
        expect(bar.end.x).toBeLessThanOrEqual(plot.right + 1e-9);
        expect(bar.end.y).toBeGreaterThanOrEqual(plot.top - 1e-9);
        expect(bar.end.y).toBeLessThanOrEqual(plot.bottom + 1e-9);
      }
      const point = chartSeriesPoint(chart, 1, undefined, scales)!;
      expect(point.y).toBeGreaterThanOrEqual(plot.top - 1e-9);
      expect(point.y).toBeLessThanOrEqual(plot.bottom + 1e-9);
      expect(point.x).toBeLessThanOrEqual(plot.right + 1e-9);
    }
  });
});
