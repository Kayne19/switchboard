import type { ChartData, ChartKind, ChartSeries } from '../controller/types';

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
const CHART_ELLIPSIS = '…';
// The grid's tick text is the same monospace stack at 13px, so a category
// label's width is its character count times the legend's advance scaled
// to that size.
export const CHART_TICK_CHAR_ADVANCE = (CHART_LEGEND_CHAR_ADVANCE * 13) / 11;
// Clear space between two neighbouring category labels along the x axis.
export const CHART_TICK_GAP = 14;
// One row of tick text: the advance from a staggered row to the next, and
// the least a horizontal bar chart gives each labelled category.
export const CHART_TICK_ROW_HEIGHT = 16;
// The row of x tick text sits this far below the plot, where the numeric
// ticks have always sat (`height - 20` with the base bottom padding).
export const CHART_TICK_BASELINE = CHART_PAD.bottom - 20;
// A horizontal bar chart's category labels end 14 before the plot, as the y
// ticks do, and leave the rotated axis label its strip on the far left.
const CHART_CATEGORY_PAD_GAP = 40;
// The most of the width those labels may take; a longer one is truncated.
export const CHART_CATEGORY_PAD_MAX = 340;
// The share of a bar chart's band its group of bars fills.
const CHART_BAR_GROUP_SHARE = 0.72;

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

function truncateLabel(name: string, maxWidth: number, advance: number): { text: string; truncated: boolean } {
  if (name.length * advance <= maxWidth) return { text: name, truncated: false };
  // Reserve one character's width for the ellipsis itself.
  const maxChars = Math.max(0, Math.floor(maxWidth / advance) - 1);
  return { text: `${name.slice(0, maxChars)}${CHART_ELLIPSIS}`, truncated: true };
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
      ({ text, truncated } = truncateLabel(series.name, availableText, CHART_LEGEND_CHAR_ADVANCE));
      contentWidth = CHART_LEGEND_TEXT_X + text.length * CHART_LEGEND_CHAR_ADVANCE;
    }
    items.push({ name: series.name, text, truncated, x: cursor, row });
    cursor += Math.max(CHART_LEGEND_STEP, contentWidth + CHART_LEGEND_GAP);
  }
  return { items, rows: row + 1 };
}

/** The chart's kind: how its series are drawn; a line when unset. */
export function chartKind(data: ChartData): ChartKind {
  return data.kind ?? 'line';
}

/**
 * The chart's categories along its x axis: its labels when it has them,
 * and for a bar chart without labels its value indices, since a bar stands
 * for one category and nothing else. A chart with neither has a numeric x.
 */
export function chartCategories(data: ChartData): string[] | undefined {
  if (data.labels && data.labels.length > 0) return data.labels;
  if (chartKind(data) !== 'bar') return undefined;
  const count = Math.max(0, ...data.series.map((series) => series.values.length));
  return count > 0 ? Array.from({ length: count }, (_, index) => String(index)) : undefined;
}

/** One category label drawn on the axis. */
export interface ChartTick {
  index: number;
  /** The label actually drawn: the category, or an ellipsis-truncated prefix of it. */
  text: string;
  truncated: boolean;
  /** Which staggered row the label sits on below the plot, 0-based. */
  row: number;
}

export interface ChartCategoryLayout {
  /** The categories, in index order; none for a numeric x axis. */
  categories?: string[];
  /** Bars run across the chart, with a labelled row per category down its left. */
  horizontal: boolean;
  /** The labels drawn, in category order: every `step`-th category. */
  ticks: ChartTick[];
  /** How many rows the x labels stagger onto; 1 for a numeric axis. */
  rows: number;
  step: number;
}

function upright(categories: string[] | undefined, ticks: ChartTick[], rows: number, step: number): ChartCategoryLayout {
  return { categories, horizontal: false, ticks, rows, step };
}

// How many legend rows the plot's top padding grows by. A line passes
// under the legend's one row where it must; a bar standing at the first
// category would run through it, so a bar chart's plot starts below the
// legend's last row.
function legendRowsAbovePlot(kind: ChartKind, legendRows: number): number {
  return Math.max(0, kind === 'bar' ? legendRows : legendRows - 1);
}

/**
 * How a chart's category labels are laid along its axis, decided from the
 * geometry alone. A row of labels that fits the plot is drawn as it is.
 * One that does not is staggered onto two rows when that fits, and failing
 * that thinned to every n-th label -- staggered too, when that shows more
 * of them. A bar chart is read by its category names, so before either it
 * turns on its side instead, with a row per category down the left, as long
 * as a row of tick text per category fits the plot's height; its longest
 * label may take up to `CHART_CATEGORY_PAD_MAX` of the width before it is
 * truncated. The height is judged with the legend as laid out for an
 * upright chart; a legend that wraps one row further on the narrower
 * horizontal plot costs each row a unit or so, not the decision.
 */
export function chartCategoryLayout(data: ChartData): ChartCategoryLayout {
  const categories = chartCategories(data);
  if (!categories) return upright(undefined, [], 1, 1);
  const count = categories.length;
  const kind = chartKind(data);
  const plotWidth = CHART_VIEW_WIDTH - CHART_PAD.left - CHART_PAD.right;
  const legendRows = chartLegendLayout(data).rows;
  const plotHeight = CHART_VIEW_HEIGHT - CHART_PAD.top - legendRowsAbovePlot(kind, legendRows) * CHART_LEGEND_ROW_HEIGHT - CHART_PAD.bottom;
  const widest = Math.max(...categories.map((label) => label.length)) * CHART_TICK_CHAR_ADVANCE + CHART_TICK_GAP;
  // Bars take a band each; the other kinds spread their categories edge to edge.
  const slot = kind === 'bar' ? plotWidth / count : count > 1 ? plotWidth / (count - 1) : plotWidth;
  const tick = (index: number, row: number): ChartTick => ({ index, text: categories[index], truncated: false, row });
  if (widest <= slot) return upright(categories, categories.map((_, index) => tick(index, 0)), 1, 1);
  if (kind === 'bar' && count * CHART_TICK_ROW_HEIGHT <= plotHeight) {
    const ticks = categories.map((label, index) => ({
      index,
      ...truncateLabel(label, CHART_CATEGORY_PAD_MAX - CHART_CATEGORY_PAD_GAP, CHART_TICK_CHAR_ADVANCE),
      row: 0,
    }));
    return { categories, horizontal: true, ticks, rows: 1, step: 1 };
  }
  if (widest <= 2 * slot) return upright(categories, categories.map((_, index) => tick(index, index % 2)), 2, 1);
  const step = Math.ceil(widest / slot);
  const staggeredStep = Math.ceil(widest / (2 * slot));
  const rows = staggeredStep < step ? 2 : 1;
  const chosen = rows === 2 ? staggeredStep : step;
  const ticks: ChartTick[] = [];
  for (let index = 0; index < count; index += chosen) ticks.push(tick(index, (index / chosen) % rows));
  return upright(categories, ticks, rows, chosen);
}

/**
 * The chart's padding for this data: the base padding, with `top` grown by
 * one row's height for every legend row past the first (every row, for a
 * bar chart, whose bars would otherwise stand through it), `bottom` by one
 * row of tick text for a second row of staggered labels, and `left` to fit
 * a horizontal bar chart's category labels, so none of them runs into the
 * plot.
 */
export function chartPad(data: ChartData): ChartPad {
  const categories = chartCategoryLayout(data);
  let left: number = CHART_PAD.left;
  if (categories.horizontal) {
    const widest = Math.max(0, ...categories.ticks.map((tick) => tick.text.length)) * CHART_TICK_CHAR_ADVANCE;
    left = Math.min(CHART_CATEGORY_PAD_MAX, Math.max(CHART_PAD.left, Math.ceil(widest + CHART_CATEGORY_PAD_GAP)));
  }
  const legendRows = chartLegendLayout(data, CHART_VIEW_WIDTH - left - CHART_PAD.right).rows;
  return {
    left,
    right: CHART_PAD.right,
    top: CHART_PAD.top + legendRowsAbovePlot(chartKind(data), legendRows) * CHART_LEGEND_ROW_HEIGHT,
    bottom: CHART_PAD.bottom + Math.max(0, categories.rows - 1) * CHART_TICK_ROW_HEIGHT,
  };
}

export interface ChartScales {
  kind: ChartKind;
  categories: ChartCategoryLayout;
  /** Bars run across the chart: the value axis is x and the category axis y. */
  horizontal: boolean;
  /** The x domain's end: the last category's index, or the numeric `xMax`. */
  xMax: number;
  yMin: number;
  yMax: number;
  /** The value bars and areas rise from: 0 when the y domain spans it, else the end of the domain nearest it. */
  baseline: number;
  /** A bar chart's band per category along the category axis; 0 for the other kinds. */
  band: number;
  /** Where a domain x (an epoch, or a category index, continuous) sits along the category axis. */
  xAt: (x: number) => number;
  /** Where a value sits along the value axis. */
  valueAt: (value: number) => number;
  /** The point for a domain x and a value, whichever way the chart runs. */
  pointAt: (x: number, value: number) => ViewPoint;
  /** The domain x of a series' `index`-th sample. */
  sampleX: (series: ChartSeries, index: number) => number;
  /** The plot's grid for this data, accounting for a wrapped legend and the labels. */
  plot: ViewRect;
}

export function chartScales(data: ChartData): ChartScales {
  const pad = chartPad(data);
  const plot = { left: pad.left, top: pad.top, right: CHART_VIEW_WIDTH - pad.right, bottom: CHART_VIEW_HEIGHT - pad.bottom };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const kind = chartKind(data);
  const categories = chartCategoryLayout(data);
  const horizontal = categories.horizontal;
  const values = data.series.flatMap((series) => series.values);
  // Bars and areas are read against their baseline, so their y domain
  // reaches it unless the chart says otherwise.
  const grounded = kind === 'bar' || kind === 'area';
  const yMin = data.yMin ?? (grounded ? Math.min(0, ...values) : Math.min(...values));
  const yMax = data.yMax ?? (grounded ? Math.max(0, ...values) : Math.max(...values));
  const baseline = Math.min(yMax, Math.max(yMin, 0));
  const count = categories.categories?.length;
  const maxCount = Math.max(2, ...data.series.map((series) => series.values.length));
  const xMax = count !== undefined ? count - 1 : (data.xMax ?? maxCount - 1);
  // A numeric chart with no positive x domain still spreads its samples
  // edge to edge; it is its ticks, markers and notes that have nowhere to
  // go (`chartSeriesPoint`).
  const spread = xMax > 0 ? xMax : maxCount - 1;
  const axisStart = horizontal ? plot.top : plot.left;
  const axisLength = horizontal ? plotHeight : plotWidth;
  const band = kind === 'bar' && count ? axisLength / count : 0;
  const xAt = (x: number): number => {
    if (band > 0) return axisStart + (x + 0.5) * band;
    return axisStart + (spread > 0 ? x / spread : 0) * axisLength;
  };
  const share = (value: number) => (value - yMin) / Math.max(0.000001, yMax - yMin);
  const valueAt = (value: number): number =>
    horizontal ? plot.left + share(value) * plotWidth : plot.top + (1 - share(value)) * plotHeight;
  return {
    kind,
    categories,
    horizontal,
    xMax,
    yMin,
    yMax,
    baseline,
    band,
    xAt,
    valueAt,
    pointAt: (x, value) => (horizontal ? { x: valueAt(value), y: xAt(x) } : { x: xAt(x), y: valueAt(value) }),
    // Categories are the sample indices; numeric samples spread over the domain.
    sampleX: (series, index) => (count !== undefined ? index : (index / Math.max(1, series.values.length - 1)) * spread),
    plot,
  };
}

/** The plot's grid for this data, inside the axes, in viewBox units: the
 * base padding, grown to clear a legend that wraps onto further rows and
 * the category labels. */
export function chartPlot(data: ChartData): ViewRect {
  const pad = chartPad(data);
  return { left: pad.left, top: pad.top, right: CHART_VIEW_WIDTH - pad.right, bottom: CHART_VIEW_HEIGHT - pad.bottom };
}

/** One bar of a bar chart, in viewBox units. */
export interface ChartBar {
  /** Which series, by index. */
  series: number;
  /** Which category. */
  index: number;
  value: number;
  rect: ViewRect;
  /** The bar's far end, mid-width: the point a marker or a note's leader reaches. */
  end: ViewPoint;
}

/**
 * A bar chart's bars: one per sample, grouped by category across the
 * series, the group filling its share of the band, each series' bar in
 * series order, all rising (or running) from the baseline.
 */
export function chartBars(data: ChartData, scales: ChartScales = chartScales(data)): ChartBar[] {
  if (scales.kind !== 'bar' || scales.band <= 0) return [];
  const group = scales.band * CHART_BAR_GROUP_SHARE;
  const slot = group / Math.max(1, data.series.length);
  const gap = Math.min(2, slot * 0.1);
  const base = scales.valueAt(scales.baseline);
  const bars: ChartBar[] = [];
  data.series.forEach((series, seriesIndex) => {
    series.values.forEach((value, index) => {
      const start = scales.xAt(index) - group / 2 + seriesIndex * slot + gap / 2;
      const stop = start + slot - gap;
      const far = scales.valueAt(value);
      const rect = scales.horizontal
        ? { left: Math.min(base, far), right: Math.max(base, far), top: start, bottom: stop }
        : { left: start, right: stop, top: Math.min(base, far), bottom: Math.max(base, far) };
      const mid = (start + stop) / 2;
      bars.push({ series: seriesIndex, index, value, rect, end: scales.horizontal ? { x: far, y: mid } : { x: mid, y: far } });
    });
  });
  return bars;
}

/** The radius of a scatter chart's point markers, in viewBox units. */
export const CHART_POINT_RADIUS = 4;

function outline(rect: ViewRect): ViewPoint[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
    { x: rect.left, y: rect.top },
  ];
}

/**
 * What the chart draws for each series, as polylines in viewBox units: the
 * line through its samples for a line or area chart, the outline of each
 * of its points for a scatter chart, and the outline of each of its bars
 * for a bar chart. The notes laid over a chart keep clear of these.
 */
export function chartTraces(data: ChartData, scales: ChartScales = chartScales(data)): ViewPoint[][] {
  if (scales.kind === 'bar') return chartBars(data, scales).map((bar) => outline(bar.rect));
  const traces = data.series.map((series) => series.values.map((value, index) => scales.pointAt(scales.sampleX(series, index), value)));
  if (scales.kind !== 'scatter') return traces;
  const r = CHART_POINT_RADIUS;
  return traces.flatMap((trace) => trace.map((point) => outline({ left: point.x - r, top: point.y - r, right: point.x + r, bottom: point.y + r })));
}

/**
 * The point on the drawn series at `x`, or undefined when there is none to
 * reach: a numeric chart with no positive x domain, or a series with no
 * values. The x is held inside the series' own domain -- an out-of-range x
 * lands on its nearest end rather than off the plot -- and the value is
 * interpolated between the samples either side of it, the same straight
 * segment a line chart draws there; on a bar chart it is the nearest
 * category's bar, and the point its far end. A series name the chart does
 * not carry falls back to its first series.
 */
export function chartSeriesPoint(
  data: ChartData,
  x: number,
  seriesName?: string,
  scales: ChartScales = chartScales(data),
): ViewPoint | undefined {
  const seriesIndex = seriesName ? data.series.findIndex((candidate) => candidate.name === seriesName) : -1;
  const series = data.series[seriesIndex] ?? data.series[0];
  if (!series || series.values.length === 0 || !Number.isFinite(x)) return undefined;
  const categorical = scales.categories.categories !== undefined;
  if (!categorical && !(scales.xMax > 0)) return undefined;
  const last = series.values.length - 1;
  if (scales.kind === 'bar') {
    const index = Math.round(Math.min(last, Math.max(0, x)));
    const which = seriesIndex >= 0 ? seriesIndex : 0;
    const bar = chartBars(data, scales).find((candidate) => candidate.series === which && candidate.index === index);
    return bar?.end;
  }
  const domainX = Math.min(categorical ? last : scales.xMax, Math.max(0, x));
  const position = categorical ? domainX : (domainX / scales.xMax) * last;
  const lower = Math.floor(position);
  const upper = Math.min(last, lower + 1);
  const value = series.values[lower] + (series.values[upper] - series.values[lower]) * (position - lower);
  // Held inside the plot, as the drawn series is by its clip.
  return scales.pointAt(domainX, Math.min(scales.yMax, Math.max(scales.yMin, value)));
}

/** The legend's own box, across the top of the plot, in viewBox units: every
 * row its items wrap onto, each as wide as its longest item's real content. */
export function chartLegendBox(data: ChartData): ViewRect {
  const pad = chartPad(data);
  const layout = chartLegendLayout(data, CHART_VIEW_WIDTH - pad.left - pad.right);
  // Its keys sit on this line, its 11-unit labels across it.
  const left = pad.left + 8;
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
