import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { TYPE_FLOOR_PX } from '../../src/design/tokens';
import {
  CHART_CATEGORY_PAD_MAX,
  CHART_FRAME,
  CHART_MIN_FRAME,
  CHART_READABLE_SCALE,
  CHART_TEXT,
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
  chartFrame,
  chartLegendBox,
  chartObstacles,
  chartPad,
  chartScales,
  chartSeriesPoint,
  chartTargetText,
  chartValueAxis,
  wrapLabel,
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

  it('wraps a horizontal bar chart label onto the lines its row holds, and truncates it only past them', () => {
    // Three rows a third of the plot tall: room for three lines each.
    const roomy = chartCategoryLayout(labelled(3, 80, 'bar'));
    expect(roomy.horizontal).toBe(true);
    expect(roomy.ticks[0].truncated).toBe(false);
    expect(roomy.ticks[0].lines).toHaveLength(3);
    expect(roomy.ticks[0].lines.join('')).toBe(labelled(3, 80).labels![0]);
    // Ten rows: two lines each, and a 120-character label runs past them.
    const chart = labelled(10, 120, 'bar');
    const layout = chartCategoryLayout(chart);
    expect(layout.horizontal).toBe(true);
    expect(layout.ticks[0].lines).toHaveLength(2);
    expect(layout.ticks[0].truncated).toBe(true);
    expect(layout.ticks[0].lines[1].endsWith('…')).toBe(true);
    // The plot moves right only as far as the longest line needs, never past the cap.
    const pad = chartPad(chart);
    const longest = Math.max(...layout.ticks.flatMap((tick) => tick.lines.map((line) => line.length)));
    expect(pad.left).toBeLessThanOrEqual(CHART_CATEGORY_PAD_MAX);
    expect(pad.left).toBeGreaterThanOrEqual(longest * CHART_TICK_CHAR_ADVANCE + 14);
    expect(longest * CHART_TICK_CHAR_ADVANCE).toBeLessThanOrEqual(CHART_CATEGORY_PAD_MAX - 40);
  });

  it('breaks a label after a space or a separator, inside a word only where the word alone is too long', () => {
    expect(wrapLabel('apps/frontend/tests/unit/notePlacement.test.ts', 26, 3).lines).toEqual(['apps/frontend/tests/unit/', 'notePlacement.test.ts']);
    expect(wrapLabel('frontend visual', 10, 2).lines).toEqual(['frontend', 'visual']);
    expect(wrapLabel('frontend visual', 20, 2)).toEqual({ text: 'frontend visual', lines: ['frontend visual'], truncated: false });
    expect(wrapLabel('abcdefghijklmnop', 6, 3).lines).toEqual(['abcdef', 'ghijkl', 'mnop']);
    // A path cut short keeps its file name: the ellipsis leads.
    const path = wrapLabel('apps/backend/tests/test_visual_protocol.rs', 16, 2);
    expect(path.truncated).toBe(true);
    expect(path.lines).toEqual(['…test_visual_', 'protocol.rs']);
    const cut = wrapLabel('one two three four five six', 8, 2);
    expect(cut.truncated).toBe(true);
    expect(cut.lines[0]).toBe('one two');
    expect(cut.lines[1].endsWith('…')).toBe(true);
    expect(cut.lines[1].length).toBeLessThanOrEqual(8);
  });

  it('leaves the bars seven tenths of the width, a long label wrapping instead', () => {
    const chart = labelled(6, 40, 'bar');
    expect(chartScales(chart).plot.left).toBeLessThanOrEqual(300);
    expect(chartCategoryLayout(chart).ticks[0].lines).toHaveLength(2);
  });

  it('gives a narrow frame the same share of its width for the labels', () => {
    const chart = labelled(6, 40, 'bar');
    const narrow = { width: 538, height: 618 };
    const layout = chartCategoryLayout(chart, narrow);
    expect(layout.horizontal).toBe(true);
    const pad = chartPad(chart, narrow);
    expect(pad.left).toBeLessThanOrEqual(Math.ceil((CHART_CATEGORY_PAD_MAX * 538) / 1000));
    for (const tick of layout.ticks) for (const line of tick.lines) expect(line.length * CHART_TICK_CHAR_ADVANCE).toBeLessThanOrEqual(pad.left - 40 + 1e-9);
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

// A value axis is read off its ticks: round values, and room past the
// tallest bar. The comparison chart's axis was labelled 0.00, 34.30, 68.60
// and 102.90, its tallest bar touching the top of the plot, so a note had
// no place inside it.
describe('chart value axis', () => {
  const suite: ChartData = {
    kind: 'bar',
    labels: ['backend', 'frontend unit', 'frontend visual', 'host agent', 'skill', 'hygiene'],
    series: [
      { name: 'THIS RUN', values: [41.8, 3.3, 96.4, 6.1, 0.3, 0.4] },
      { name: 'PREVIOUS RUN', values: [44.0, 3.1, 102.9, 6.4, 0.3, 0.4] },
    ],
  };

  it('labels a bar chart at round values, with headroom above its tallest bar', () => {
    const axis = chartValueAxis(suite);
    expect(axis).toEqual({ min: 0, max: 125, ticks: [0, 25, 50, 75, 100, 125], decimals: 0 });
    const scales = chartScales(suite);
    const tallest = Math.min(...chartBars(suite, scales).map((bar) => bar.rect.top));
    const plotHeight = scales.plot.bottom - scales.plot.top;
    expect(tallest - scales.plot.top).toBeGreaterThanOrEqual(0.1 * plotHeight);
  });

  it('keeps both ends a chart gives, labelled at even divisions as before', () => {
    const axis = chartValueAxis({ yMin: 0.08, yMax: 0.3, series: [{ name: 'LOSS', values: [0.2, 0.1] }] });
    expect(axis.min).toBe(0.08);
    expect(axis.max).toBe(0.3);
    expect(axis.ticks.map((tick) => Number(tick.toFixed(4)))).toEqual([0.3, 0.2267, 0.1533, 0.08]);
    expect(axis.decimals).toBe(2);
  });

  it('keeps the end a chart gives and rounds the other', () => {
    const axis = chartValueAxis({ kind: 'bar', yMax: 100, labels: ['a', 'b'], series: [{ name: 'UP', values: [99.9, 99.6] }] });
    expect(axis.min).toBe(0);
    expect(axis.max).toBe(100);
    expect(axis.ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("rounds a line's own domain out to round values, with no headroom it does not need", () => {
    expect(chartValueAxis({ kind: 'scatter', xMax: 10, series: [{ name: 'MS', values: [8.1, 90, 41] }] })).toEqual({
      min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100], decimals: 0,
    });
    expect(chartValueAxis({ series: [{ name: 'LOSS', values: [0.31, 0.12, 0.18] }] })).toEqual({
      min: 0.1, max: 0.35, ticks: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35], decimals: 2,
    });
  });

  it('leaves headroom past the most negative bar too, and prints a step of 2.5 with its decimal', () => {
    expect(chartValueAxis({ kind: 'bar', labels: ['a', 'b'], series: [{ name: 'S', values: [-30, 20] }] }).ticks).toEqual([-40, -20, 0, 20, 40]);
    expect(chartValueAxis({ kind: 'bar', labels: ['a'], series: [{ name: 'S', values: [10.4] }] })).toEqual({
      min: 0, max: 12.5, ticks: [0, 2.5, 5, 7.5, 10, 12.5], decimals: 1,
    });
  });

  it('gives a flat series a domain to stand in', () => {
    expect(chartValueAxis({ series: [{ name: 'S', values: [5, 5, 5] }] })).toMatchObject({ min: 4, max: 6 });
    expect(chartValueAxis({ kind: 'bar', labels: ['a'], series: [{ name: 'S', values: [0] }] }).max).toBeGreaterThan(0);
  });
});

// The frame a chart is drawn in is the slot's to decide. On a phone the
// chart was the 1000x500 canvas drawn at a third of its size: tick text at
// 4px, tiny bars, and bands of black above and below it inside the frame.
describe('chart frame for a slot', () => {
  const css = readFileSync(`${import.meta.dirname}/../../src/styles/index.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // The size the last rule naming a selector sets: the rule that wins.
  const sizeOf = (selector: string) => {
    const rules = [...css.matchAll(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')}[^{]*\\{([^}]*)\\}`, 'g'))];
    const sizes = rules.map((rule) => /font-size:\s*(\d+(?:\.\d+)?)px/.exec(rule[2])?.[1]).filter(Boolean);
    return Number(sizes.at(-1));
  };

  it("names the chart's own text sizes and the faces whose floors they keep", () => {
    expect(sizeOf('.chart-grid text')).toBe(13);
    expect(sizeOf('.chart-axis-label')).toBe(11);
    expect(sizeOf('.chart-legend text')).toBe(11);
    expect(CHART_TEXT.map((text) => text.size).sort()).toEqual([11, 13]);
    for (const text of CHART_TEXT) expect(text.size * CHART_READABLE_SCALE).toBeGreaterThanOrEqual(TYPE_FLOOR_PX[text.floor] - 1e-9);
  });

  it('keeps the approved canvas in the landscape slots it was approved in', () => {
    // The training chart's slot at 1440x900, 1280x720 and 2560x1080.
    expect(chartFrame({ width: 937, height: 561 })).toEqual({ ...CHART_FRAME, scale: 0.937 });
    expect(chartFrame({ width: 833, height: 432 })).toEqual({ ...CHART_FRAME, scale: 0.833 });
    // Wider than the canvas: drawn across its height, the room beside it the notes'.
    expect(chartFrame({ width: 2008, height: 647 })).toEqual({ ...CHART_FRAME, scale: 647 / 500 });
    // Not measured yet.
    expect(chartFrame({ width: 0, height: 0 })).toEqual({ ...CHART_FRAME, scale: 1 });
  });

  it("takes a portrait slot's own shape, its text never under the page's floors", () => {
    // The training chart's slot at 390x844: the canvas would draw at 0.34.
    const phone = chartFrame({ width: 342, height: 393 });
    expect(phone.scale).toBeCloseTo(CHART_READABLE_SCALE);
    expect(phone.width).toBe(Math.round(342 / CHART_READABLE_SCALE));
    expect(phone.height).toBe(Math.round(393 / CHART_READABLE_SCALE));
    // At 820x1180 the canvas reads, but leaves a third of the slot black.
    expect(chartFrame({ width: 738, height: 581 })).toEqual({ width: 1000, height: 787, scale: 0.738 });
  });

  it('draws a short wide slot at the readable scale, wider than the canvas', () => {
    const frame = chartFrame({ width: 541, height: 182 });
    expect(frame.scale).toBeCloseTo(CHART_READABLE_SCALE);
    expect(frame.width / frame.height).toBeCloseTo(541 / 182, 1);
  });

  it('draws a slot too small for its least frame at the readable scale smaller, never cropped', () => {
    const frame = chartFrame({ width: 300, height: 100 });
    expect(frame.height).toBe(CHART_MIN_FRAME.height);
    expect(frame.scale).toBeCloseTo(100 / CHART_MIN_FRAME.height);
    expect(frame.width).toBe(Math.round(300 / frame.scale));
  });

  it('lays a recomposed plot out in the frame it is given', () => {
    const chart: ChartData = { kind: 'bar', labels: ['a', 'b', 'c'], series: [{ name: 'S', values: [1, 2, 3] }] };
    const frame = { width: 538, height: 618 };
    const scales = chartScales(chart, frame);
    expect(scales.frame).toEqual(frame);
    expect(scales.plot).toEqual({ left: CHART_PAD.left, top: CHART_PAD.top + CHART_LEGEND_ROW_HEIGHT, right: 538 - CHART_PAD.right, bottom: 618 - CHART_PAD.bottom });
    expect(chartAxisBoxes(scales.plot, frame)[1]).toMatchObject({ right: 538, bottom: 618 });
  });
});

describe('what a note names on a chart', () => {
  it("is the category at the note's x, and its series, on a labelled chart", () => {
    const chart: ChartData = { kind: 'bar', labels: ['backend', 'frontend visual'], series: [{ name: 'THIS RUN', values: [1, 2] }] };
    expect(chartTargetText({ x: 1, series: 'THIS RUN' }, chart)).toBe('frontend visual / THIS RUN');
    expect(chartTargetText({ x: 0.4 }, chart)).toBe('backend');
    expect(chartTargetText({ x: 9 }, chart)).toBe('frontend visual');
  });

  it('is left to the anchor as sent where the chart has no labels or the note no x', () => {
    expect(chartTargetText({ x: 2 }, { xMax: 10, series: [{ name: 'S', values: [1, 2] }] })).toBeUndefined();
    expect(chartTargetText({ x: 2 }, { kind: 'bar', series: [{ name: 'S', values: [1, 2, 3] }] })).toBeUndefined();
    expect(chartTargetText({ series: 'S' }, { labels: ['a'], series: [{ name: 'S', values: [1] }] })).toBeUndefined();
  });
});
