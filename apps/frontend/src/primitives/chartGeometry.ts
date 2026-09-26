import type { ChartData } from '../controller/types';

// The chart's viewBox is a fixed geometry. The chart draws in it, and the
// notes laid over a chart map their points and the drawn traces through it,
// so both read the same scales from here instead of re-declaring them.
export const CHART_VIEW_WIDTH = 1000;
export const CHART_VIEW_HEIGHT = 500;
// The padding for a chart whose legend fits on one row. A legend that wraps
// grows `top` past this floor (see `chartPad`) so the plot never sits under
// a wrapped row; the base value is what every existing chart still gets.
export const CHART_PAD = { left: 74, right: 28, top: 34, bottom: 54 } as const;
// A legend entry's advance along its row, in viewBox units: at least this
// far, more if the label needs the room (see `chartLegendLayout`).
export const CHART_LEGEND_STEP = 178;
// The legend text's x offset from its item's own origin: the 24-unit color
// key plus a 10-unit gap to the label. `ChartPrimitive` draws the key and
// text at these same offsets, so a change here is a change there too.
export const CHART_LEGEND_KEY_WIDTH = 24;
export const CHART_LEGEND_TEXT_X = 34;
// Clear space after a label's own text before the next item's key may start.
export const CHART_LEGEND_GAP = 32;
// The vertical advance from one wrapped legend row to the next.
export const CHART_LEGEND_ROW_HEIGHT = 20;
// The legend text is `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
// monospace` at 11px with 0.08em letter-spacing (see index.css). jsdom (where
// the unit tests run) cannot measure SVG text, but a monospace font makes the
// measurement unnecessary: every glyph advances the same amount, so a
// label's width is exactly its character count times that advance. Measured
// against the same font stack in the Chromium the visual suite renders with
// (getComputedTextLength), the advance is 7.5 viewBox units per character.
export const CHART_LEGEND_CHAR_ADVANCE = 7.5;
const CHART_LEGEND_ELLIPSIS = '…';

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

export interface ChartPad {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One legend entry's resolved position and label, in the legend's own row-major flow. */
export interface ChartLegendItem {
  name: string;
  /** The label actually drawn: `name`, or an ellipsis-truncated prefix of it. */
  text: string;
  truncated: boolean;
  /** Offset from the legend's origin along its row. */
  x: number;
  /** Which row the item wraps onto, 0-based. */
  row: number;
}

export interface ChartLegendLayout {
  items: ChartLegendItem[];
  rows: number;
}

function truncateLegendLabel(name: string, maxWidth: number): { text: string; truncated: boolean } {
  if (name.length * CHART_LEGEND_CHAR_ADVANCE <= maxWidth) return { text: name, truncated: false };
  // Reserve one character's width for the ellipsis itself.
  const maxChars = Math.max(0, Math.floor(maxWidth / CHART_LEGEND_CHAR_ADVANCE) - 1);
  return { text: `${name.slice(0, maxChars)}${CHART_LEGEND_ELLIPSIS}`, truncated: true };
}

/**
 * Where each legend entry sits: each item advances by its own width (or the
 * default step, whichever is larger) along a row, wraps onto a further row
 * when the next item would run past `plotWidth`, and is truncated with an
 * ellipsis when even a row to itself is not wide enough for it.
 */
export function chartLegendLayout(
  data: ChartData,
  plotWidth: number = CHART_VIEW_WIDTH - CHART_PAD.left - CHART_PAD.right,
): ChartLegendLayout {
  const items: ChartLegendItem[] = [];
  let cursor = 0;
  let row = 0;
  const availableText = plotWidth - CHART_LEGEND_TEXT_X;
  for (const series of data.series) {
    let contentWidth = CHART_LEGEND_TEXT_X + series.name.length * CHART_LEGEND_CHAR_ADVANCE;
    if (cursor > 0 && cursor + contentWidth > plotWidth) {
      row += 1;
      cursor = 0;
    }
    let text = series.name;
    let truncated = false;
    if (contentWidth > plotWidth) {
      ({ text, truncated } = truncateLegendLabel(series.name, availableText));
      contentWidth = CHART_LEGEND_TEXT_X + text.length * CHART_LEGEND_CHAR_ADVANCE;
    }
    items.push({ name: series.name, text, truncated, x: cursor, row });
    cursor += Math.max(CHART_LEGEND_STEP, contentWidth + CHART_LEGEND_GAP);
  }
  return { items, rows: row + 1 };
}

/**
 * The chart's padding for this data: the base padding, with `top` grown by
 * one row's height for every legend row past the first, so a wrapped legend
 * gets room instead of running into the plot.
 */
export function chartPad(data: ChartData): ChartPad {
  const rows = chartLegendLayout(data).rows;
  return { ...CHART_PAD, top: CHART_PAD.top + Math.max(0, rows - 1) * CHART_LEGEND_ROW_HEIGHT };
}

export interface ChartScales {
  xMax: number;
  yMin: number;
  yMax: number;
  xAtEpoch: (epoch: number) => number;
  xAtIndex: (index: number, length: number) => number;
  yAt: (value: number) => number;
  /** The plot's grid for this data, accounting for a wrapped legend. */
  plot: ViewRect;
}

export function chartScales(data: ChartData): ChartScales {
  const pad = chartPad(data);
  const plotWidth = CHART_VIEW_WIDTH - pad.left - pad.right;
  const plotHeight = CHART_VIEW_HEIGHT - pad.top - pad.bottom;
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
    xAtEpoch: (epoch) => pad.left + (xMax > 0 ? epoch / xMax : 0) * plotWidth,
    xAtIndex: (index, length) => pad.left + (index / Math.max(1, length - 1)) * plotWidth,
    yAt: (value) => pad.top + (1 - (value - yMin) / Math.max(0.000001, yMax - yMin)) * plotHeight,
    plot: { left: pad.left, top: pad.top, right: CHART_VIEW_WIDTH - pad.right, bottom: CHART_VIEW_HEIGHT - pad.bottom },
  };
}

/** The plot's grid for this data, inside the axes, in viewBox units: the
 * base padding, grown to clear a legend that wraps onto further rows. */
export function chartPlot(data: ChartData): ViewRect {
  const pad = chartPad(data);
  return { left: pad.left, top: pad.top, right: CHART_VIEW_WIDTH - pad.right, bottom: CHART_VIEW_HEIGHT - pad.bottom };
}

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
    y: Math.min(scales.plot.bottom, Math.max(scales.plot.top, scales.yAt(value))),
  };
}

/** The legend's own box, across the top of the plot, in viewBox units: every
 * row its items wrap onto, each as wide as its longest item's real content. */
export function chartLegendBox(data: ChartData): ViewRect {
  const plotWidth = CHART_VIEW_WIDTH - CHART_PAD.left - CHART_PAD.right;
  const layout = chartLegendLayout(data, plotWidth);
  // Its keys sit on this line, its 11-unit labels across it.
  const left = CHART_PAD.left + 8;
  const line = CHART_PAD.top + 12;
  const right =
    left +
    (layout.items.length > 0
      ? Math.max(...layout.items.map((item) => item.x + CHART_LEGEND_TEXT_X + item.text.length * CHART_LEGEND_CHAR_ADVANCE))
      : CHART_LEGEND_STEP - 40);
  return { left, top: line - 7, right, bottom: line + 6 + (layout.rows - 1) * CHART_LEGEND_ROW_HEIGHT };
}

/** The axis labels' strips beside and beneath a chart's plot, in viewBox units. */
export function chartAxisBoxes(plot: ViewRect): ViewRect[] {
  return [
    { left: 0, top: plot.top - 8, right: plot.left, bottom: plot.bottom + 8 },
    { left: plot.left - 20, top: plot.bottom, right: CHART_VIEW_WIDTH, bottom: CHART_VIEW_HEIGHT },
  ];
}
