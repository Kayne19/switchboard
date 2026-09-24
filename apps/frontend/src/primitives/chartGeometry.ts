import type { ChartData } from '../controller/types';

// The chart's viewBox is a fixed geometry. The chart draws in it, and the
// notes laid over a chart map their points and the drawn traces through it,
// so both read the same scales from here instead of re-declaring them.
export const CHART_VIEW_WIDTH = 1000;
export const CHART_VIEW_HEIGHT = 500;
export const CHART_PAD = { left: 74, right: 28, top: 34, bottom: 54 } as const;
// Each legend entry's advance along the legend row, in viewBox units.
export const CHART_LEGEND_STEP = 178;

export interface ViewPoint {
  x: number;
  y: number;
}

export interface ViewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChartScales {
  xMax: number;
  yMin: number;
  yMax: number;
  xAtEpoch: (epoch: number) => number;
  xAtIndex: (index: number, length: number) => number;
  yAt: (value: number) => number;
}

export function chartScales(data: ChartData): ChartScales {
  const plotWidth = CHART_VIEW_WIDTH - CHART_PAD.left - CHART_PAD.right;
  const plotHeight = CHART_VIEW_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const values = data.series.flatMap((series) => series.values);
  const yMin = data.yMin ?? Math.min(...values);
  const yMax = data.yMax ?? Math.max(...values);
  const maxCount = Math.max(2, ...data.series.map((series) => series.values.length));
  const xMax = data.xMax ?? maxCount - 1;
  return {
    xMax,
    yMin,
    yMax,
    // A chart with no positive x domain draws everything at its left edge.
    xAtEpoch: (epoch) => CHART_PAD.left + (xMax > 0 ? epoch / xMax : 0) * plotWidth,
    xAtIndex: (index, length) => CHART_PAD.left + (index / Math.max(1, length - 1)) * plotWidth,
    yAt: (value) => CHART_PAD.top + (1 - (value - yMin) / Math.max(0.000001, yMax - yMin)) * plotHeight,
  };
}

/** The plot's grid, inside the axes, in viewBox units. */
export const CHART_PLOT: ViewRect = {
  left: CHART_PAD.left,
  top: CHART_PAD.top,
  right: CHART_VIEW_WIDTH - CHART_PAD.right,
  bottom: CHART_VIEW_HEIGHT - CHART_PAD.bottom,
};

/** Each series as the polyline the chart draws for it, in viewBox units. */
export function chartTraces(data: ChartData, scales: ChartScales = chartScales(data)): ViewPoint[][] {
  return data.series.map((series) =>
    series.values.map((value, index) => ({ x: scales.xAtIndex(index, series.values.length), y: scales.yAt(value) })),
  );
}

/**
 * The point on the drawn line at `x`, or undefined when there is none to
 * reach: a chart with no positive x domain, or a series with no values. The
 * x is held inside the chart's domain -- an out-of-range x lands on the
 * nearest end rather than off the plot -- and the value is interpolated
 * between the samples either side of it, the same straight segment the
 * series path draws there. A series name the chart does not carry falls
 * back to its first series.
 */
export function chartSeriesPoint(
  data: ChartData,
  x: number,
  seriesName?: string,
  scales: ChartScales = chartScales(data),
): ViewPoint | undefined {
  const series = (seriesName ? data.series.find((candidate) => candidate.name === seriesName) : undefined) ?? data.series[0];
  if (!series || series.values.length === 0 || !(scales.xMax > 0) || !Number.isFinite(x)) return undefined;
  const epoch = Math.min(scales.xMax, Math.max(0, x));
  const last = series.values.length - 1;
  const position = (epoch / scales.xMax) * last;
  const lower = Math.floor(position);
  const upper = Math.min(last, lower + 1);
  const value = series.values[lower] + (series.values[upper] - series.values[lower]) * (position - lower);
  return {
    x: scales.xAtEpoch(epoch),
    y: Math.min(CHART_PLOT.bottom, Math.max(CHART_PLOT.top, scales.yAt(value))),
  };
}

/** The legend row across the top of the plot, in viewBox units. */
export function chartLegendBox(data: ChartData): ViewRect {
  // Its keys sit on this line, its 11-unit labels across it.
  const left = CHART_PAD.left + 8;
  const line = CHART_PAD.top + 12;
  return { left, top: line - 7, right: left + Math.max(1, data.series.length) * CHART_LEGEND_STEP - 40, bottom: line + 6 };
}

/** The axis labels' strips beside and beneath the plot, in viewBox units. */
export function chartAxisBoxes(): ViewRect[] {
  return [
    { left: 0, top: CHART_PLOT.top - 8, right: CHART_PLOT.left, bottom: CHART_PLOT.bottom + 8 },
    { left: CHART_PLOT.left - 20, top: CHART_PLOT.bottom, right: CHART_VIEW_WIDTH, bottom: CHART_VIEW_HEIGHT },
  ];
}
