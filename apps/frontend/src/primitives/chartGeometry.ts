import type { ChartData, ChartKind, ChartSeries } from '../controller/types';
import { readableScale, type DrawingText } from './drawingFit';

// The chart draws in a viewBox -- its frame -- and the notes laid over a
// chart map their points and the drawn marks through the same frame, so both
// read the same scales from here instead of re-declaring them. The approved
// canvas is 1000 by 500 units; a slot it does not read well in gets a frame
// of its own shape (`chartFrame`).
export const CHART_VIEW_WIDTH = 1000;
export const CHART_VIEW_HEIGHT = 500;

/** The chart's viewBox, in its own units. */
export interface ChartFrame {
  width: number;
  height: number;
}

/** The approved canvas: the frame every chart is drawn in where it reads. */
export const CHART_FRAME: ChartFrame = { width: CHART_VIEW_WIDTH, height: CHART_VIEW_HEIGHT };

// The chart's text, in viewBox units, and the page face whose floor each
// line keeps: the tick text is 13 units, the legend and the axis names 11
// (styles/index.css; a test holds the two in step).
export const CHART_TEXT: DrawingText[] = [
  { size: 13, floor: 'tech' },
  { size: 11, floor: 'micro' },
];
/** The least scale at which every line of a chart's text meets the page's type floors. */
export const CHART_READABLE_SCALE = readableScale(CHART_TEXT);
// How much taller than the approved canvas drawn across it a slot may be
// before the chart is recomposed for it: the landscape slots the canvas was
// approved in leave up to a fifth of their height to the band above and
// below it, where the notes sit.
const CHART_TALL_SLACK = 1.25;
// The least frame a chart is recomposed into: room for its legend, its
// axes' text and a plot a few rows of tick text tall. A slot too small to
// give it at the readable scale draws it smaller instead; the aux row keeps
// a chart's cell at least this tall (styles/index.css), so only a slot with
// nowhere to grow (a phone's focus box on its side, say) ever does.
export const CHART_MIN_FRAME: ChartFrame = { width: 320, height: 240 };

/** A frame for a slot, and the CSS pixels per unit it is drawn at there. */
export interface ChartFit extends ChartFrame {
  scale: number;
}

/**
 * The frame a chart is drawn in, for a slot of this size in CSS pixels:
 * decided by the slot's geometry alone, never by the viewport. The
 * approved canvas holds wherever it reads -- its text at or above the
 * page's floors, and the slot no taller than a little more than the canvas
 * drawn across it; a slot wider than the canvas keeps it whole, with the
 * room beside it for the notes. Anywhere else the chart is recomposed: its
 * frame takes the slot's own shape, so the plot follows the slot instead of
 * shrinking inside bands of black, at the scale that fits the slot's width
 * or height but never below the readable one -- unless the slot cannot
 * hold even the least frame (`CHART_MIN_FRAME`) at that scale. A slot not
 * yet measured gets the approved canvas.
 */
export function chartFrame(slot: { width: number; height: number }): ChartFit {
  if (!(slot.width > 0) || !(slot.height > 0)) return { ...CHART_FRAME, scale: 1 };
  const fit = Math.min(slot.width / CHART_VIEW_WIDTH, slot.height / CHART_VIEW_HEIGHT);
  if (fit >= CHART_READABLE_SCALE && slot.height <= CHART_VIEW_HEIGHT * fit * CHART_TALL_SLACK) return { ...CHART_FRAME, scale: fit };
  const scale = Math.min(
    Math.max(CHART_READABLE_SCALE, fit),
    slot.width / CHART_MIN_FRAME.width,
    slot.height / CHART_MIN_FRAME.height,
  );
  return { width: Math.round(slot.width / scale), height: Math.round(slot.height / scale), scale };
}

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
// A frame narrower than the approved canvas gives them the same share of
// its width.
export const CHART_CATEGORY_PAD_MAX = 340;
function categoryPadMax(frame: ChartFrame): number {
  return Math.min(CHART_CATEGORY_PAD_MAX, (CHART_CATEGORY_PAD_MAX * frame.width) / CHART_VIEW_WIDTH);
}
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
  /** The lines it is drawn on: one, but a horizontal bar chart's label wraps where its row has the room. */
  lines: string[];
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

// The most lines a horizontal bar chart's category label wraps onto.
const CHART_CATEGORY_LINES = 3;

/**
 * A label set on at most `lines` lines of at most `width` characters: a
 * line breaks after a space or a path's separator where it can, and inside
 * a word only where a word alone is too long. A label that needs more
 * lines is cut with an ellipsis: at its start when it is a path, whose
 * file name at the end is what tells it apart, else at its end.
 */
export function wrapLabel(label: string, width: number, lines: number): { text: string; lines: string[]; truncated: boolean } {
  const room = Math.max(2, width);
  if (label.length <= room) return { text: label, lines: [label], truncated: false };
  // The pieces a line may end after: each run up to and including a space
  // or a separator.
  const pieces = label.match(/[^\s/_-]*[\s/_-]+|[^\s/_-]+$/g) ?? [label];
  const set = fill(pieces, room);
  if (set.length <= lines) return { text: label, lines: set, truncated: false };
  if (label.includes('/')) {
    // From the end: the pieces filled backward, the last lines kept, and
    // the first of them led by the ellipsis.
    const back = fill([...pieces].reverse(), room - 1, true).reverse();
    const kept = back.slice(-lines);
    kept[0] = `${CHART_ELLIPSIS}${kept[0]}`;
    return { text: kept.join(' '), lines: kept, truncated: true };
  }
  const kept = set.slice(0, lines - 1);
  const last = truncateLabel(set.slice(lines - 1).join(' '), room * CHART_TICK_CHAR_ADVANCE, CHART_TICK_CHAR_ADVANCE).text;
  return { text: [...kept, last].join(' '), lines: [...kept, last], truncated: true };
}

// Pieces set on lines of at most `room` characters, in order -- or, with
// `backward`, the pieces given last first, each line grown at its start.
function fill(pieces: string[], room: number, backward = false): string[] {
  const set: string[] = [];
  let line = '';
  const join = (piece: string) => (backward ? piece + line : line + piece);
  for (const piece of pieces) {
    let rest = piece;
    while (rest.length > 0) {
      if (join(rest).trim().length <= room) {
        line = join(rest);
        rest = '';
      } else if (line.length > 0) {
        set.push(line.trim());
        line = '';
      } else if (backward) {
        set.push(rest.slice(-room));
        rest = rest.slice(0, -room);
      } else {
        set.push(rest.slice(0, room));
        rest = rest.slice(room);
      }
    }
  }
  if (line.trim().length > 0) set.push(line.trim());
  return set;
}

function upright(categories: string[] | undefined, ticks: ChartTick[], rows: number, step: number): ChartCategoryLayout {
  return { categories, horizontal: false, ticks, rows, step };
}

/**
 * Where an upright chart draws a category label along its x axis: centred
 * on its category at `x`, but held inside the viewBox. A line's first and
 * last categories sit on the plot's edges, and a long label centred there
 * would run past them.
 */
export function chartCategoryLabelX(x: number, text: string, frameWidth: number = CHART_VIEW_WIDTH): number {
  const half = (text.length * CHART_TICK_CHAR_ADVANCE) / 2;
  return Math.min(frameWidth - half, Math.max(half, x));
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
 * horizontal plot costs each row a unit or so, not the decision. An upright
 * layout is taken only when its labels, held inside the viewBox where they
 * are drawn (`chartCategoryLabelX`), still clear each other on every row:
 * an edge label held in moves toward its neighbour.
 */
export function chartCategoryLayout(data: ChartData, frame: ChartFrame = CHART_FRAME): ChartCategoryLayout {
  const categories = chartCategories(data);
  if (!categories) return upright(undefined, [], 1, 1);
  const count = categories.length;
  const kind = chartKind(data);
  const plotWidth = frame.width - CHART_PAD.left - CHART_PAD.right;
  const legendRows = chartLegendLayout(data, plotWidth).rows;
  const plotHeight = frame.height - CHART_PAD.top - legendRowsAbovePlot(kind, legendRows) * CHART_LEGEND_ROW_HEIGHT - CHART_PAD.bottom;
  const widest = Math.max(...categories.map((label) => label.length)) * CHART_TICK_CHAR_ADVANCE + CHART_TICK_GAP;
  // Bars take a band each; the other kinds spread their categories edge to edge.
  const slot = kind === 'bar' ? plotWidth / count : count > 1 ? plotWidth / (count - 1) : plotWidth;
  // Every `step`-th category labelled, the labels taking `rows` rows in turn.
  const laid = (rows: number, step: number): ChartTick[] => {
    const ticks: ChartTick[] = [];
    for (let index = 0; index < count; index += step) ticks.push({ index, text: categories[index], lines: [categories[index]], truncated: false, row: (index / step) % rows });
    return ticks;
  };
  // Where an upright chart puts each category along its x axis (`xAt`).
  const centre = (index: number) => CHART_PAD.left + (kind === 'bar' ? (index + 0.5) * slot : count > 1 ? index * slot : 0);
  const clear = (ticks: ChartTick[]): boolean => {
    const ends = new Map<number, number>();
    for (const tick of ticks) {
      const half = (tick.text.length * CHART_TICK_CHAR_ADVANCE) / 2;
      const x = chartCategoryLabelX(centre(tick.index), tick.text, frame.width);
      const end = ends.get(tick.row);
      if (end !== undefined && x - half - end < CHART_TICK_GAP) return false;
      ends.set(tick.row, x + half);
    }
    return true;
  };
  if (widest <= slot && clear(laid(1, 1))) return upright(categories, laid(1, 1), 1, 1);
  if (kind === 'bar' && count * CHART_TICK_ROW_HEIGHT <= plotHeight) {
    // A label too long for its room wraps onto as many lines as its row
    // holds, up to three, and is truncated only past them.
    const lines = Math.max(1, Math.min(CHART_CATEGORY_LINES, Math.floor(plotHeight / count / CHART_TICK_ROW_HEIGHT)));
    const room = Math.floor((categoryPadMax(frame) - CHART_CATEGORY_PAD_GAP) / CHART_TICK_CHAR_ADVANCE);
    const ticks = categories.map((label, index) => ({ index, ...wrapLabel(label, room, lines), row: 0 }));
    return { categories, horizontal: true, ticks, rows: 1, step: 1 };
  }
  if (widest <= 2 * slot && clear(laid(2, 1))) return upright(categories, laid(2, 1), 2, 1);
  const step = Math.ceil(widest / slot);
  const staggeredStep = Math.ceil(widest / (2 * slot));
  const rows = staggeredStep < step ? 2 : 1;
  let chosen = rows === 2 ? staggeredStep : step;
  // A wider step until the edge labels clear too; one label alone always does.
  while (!clear(laid(rows, chosen))) chosen += 1;
  return upright(categories, laid(rows, chosen), rows, chosen);
}

/**
 * The chart's padding for this data: the base padding, with `top` grown by
 * one row's height for every legend row past the first (every row, for a
 * bar chart, whose bars would otherwise stand through it), `bottom` by one
 * row of tick text for a second row of staggered labels, and `left` to fit
 * a horizontal bar chart's category labels, so none of them runs into the
 * plot.
 */
export function chartPad(data: ChartData, frame: ChartFrame = CHART_FRAME): ChartPad {
  const categories = chartCategoryLayout(data, frame);
  let left: number = CHART_PAD.left;
  if (categories.horizontal) {
    const widest = Math.max(0, ...categories.ticks.flatMap((tick) => tick.lines.map((line) => line.length))) * CHART_TICK_CHAR_ADVANCE;
    left = Math.min(categoryPadMax(frame), Math.max(CHART_PAD.left, Math.ceil(widest + CHART_CATEGORY_PAD_GAP)));
  }
  const legendRows = chartLegendLayout(data, frame.width - left - CHART_PAD.right).rows;
  return {
    left,
    right: CHART_PAD.right,
    top: CHART_PAD.top + legendRowsAbovePlot(chartKind(data), legendRows) * CHART_LEGEND_ROW_HEIGHT,
    bottom: CHART_PAD.bottom + Math.max(0, categories.rows - 1) * CHART_TICK_ROW_HEIGHT,
  };
}

/** The value axis: its domain, and the values it is labelled at. */
export interface ChartValueAxis {
  min: number;
  max: number;
  /** The labelled values, each with a gridline. */
  ticks: number[];
  /** How many decimals a tick is printed with. */
  decimals: number;
}

// How much of its span a value axis the page chooses leaves above its
// largest bar or area (and below its most negative one): room for the
// value a noted bar prints past its end, and a place inside the plot for
// the note itself.
export const CHART_HEADROOM = 0.1;
// About how many intervals a value axis is cut into.
const CHART_VALUE_INTERVALS = 5;

// A round step -- 1, 2, 2.5 or 5 times a power of ten -- that cuts `span`
// into at most about `intervals` pieces.
function niceStep(span: number, intervals: number): number {
  const raw = span / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw * (1 - 1e-9)) ?? 10 * magnitude;
}

function decimalsOf(step: number): number {
  const text = String(Number(step.toPrecision(12)));
  const point = text.indexOf('.');
  return point < 0 ? 0 : text.length - point - 1;
}

/**
 * The value axis for this data. An end the chart gives is kept as given;
 * an end the page chooses is the data's own (bars and areas reach their
 * baseline at 0), rounded out to a round step, and a bar or area chart's
 * leaves `CHART_HEADROOM` of the span past its tallest value first. The
 * axis is labelled at every multiple of the step inside the domain. A chart
 * that gives both ends is labelled at four even divisions of it, ends
 * included, as it always was: its domain is the agent's, not a round one.
 */
export function chartValueAxis(data: ChartData): ChartValueAxis {
  const kind = chartKind(data);
  const values = data.series.flatMap((series) => series.values).filter((value) => Number.isFinite(value));
  // Bars and areas are read against their baseline, so their y domain
  // reaches it unless the chart says otherwise.
  const grounded = kind === 'bar' || kind === 'area';
  const low = data.yMin ?? (values.length === 0 ? 0 : grounded ? Math.min(0, ...values) : Math.min(...values));
  const high = data.yMax ?? (values.length === 0 ? 1 : grounded ? Math.max(0, ...values) : Math.max(...values));
  if (data.yMin !== undefined && data.yMax !== undefined) {
    const ticks = Array.from({ length: 4 }, (_, index) => high - ((high - low) * index) / 3);
    return { min: low, max: high, ticks, decimals: 2 };
  }
  const span = high - low > 0 ? high - low : Math.abs(high) || 1;
  const reachHigh = data.yMax ?? (grounded && high > 0 ? high + span * CHART_HEADROOM : high);
  const reachLow = data.yMin ?? (grounded && low < 0 ? low - span * CHART_HEADROOM : low);
  const flat = reachHigh - reachLow <= 0;
  const step = niceStep(flat ? span : reachHigh - reachLow, CHART_VALUE_INTERVALS);
  const round = (value: number) => Number((Math.round(value / step) * step).toPrecision(12));
  let min = data.yMin ?? Number((Math.floor(reachLow / step + 1e-9) * step).toPrecision(12));
  let max = data.yMax ?? Number((Math.ceil(reachHigh / step - 1e-9) * step).toPrecision(12));
  // A flat series still gets a domain to stand in: a step either side of
  // a line, a step past the baseline for bars.
  if (max <= min) {
    if (data.yMax !== undefined) min = Number((max - step).toPrecision(12));
    else if (data.yMin !== undefined || grounded) max = Number((min + step).toPrecision(12));
    else {
      min = Number((min - step).toPrecision(12));
      max = Number((max + step).toPrecision(12));
    }
  }
  const ticks: number[] = [];
  for (let value = round(Math.ceil(min / step - 1e-9) * step); value <= max + step * 1e-9; value = round(value + step)) ticks.push(value);
  return { min, max, ticks, decimals: decimalsOf(step) };
}

export interface ChartScales {
  /** The frame the chart is drawn in. */
  frame: ChartFrame;
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
  /** The values the value axis is labelled at, and how many decimals each is printed with. */
  valueTicks: number[];
  valueDecimals: number;
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

export function chartScales(data: ChartData, frame: ChartFrame = CHART_FRAME): ChartScales {
  const pad = chartPad(data, frame);
  const plot = { left: pad.left, top: pad.top, right: frame.width - pad.right, bottom: frame.height - pad.bottom };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const kind = chartKind(data);
  const categories = chartCategoryLayout(data, frame);
  const horizontal = categories.horizontal;
  const { min: yMin, max: yMax, ticks: valueTicks, decimals: valueDecimals } = chartValueAxis(data);
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
    frame,
    kind,
    categories,
    horizontal,
    xMax,
    yMin,
    yMax,
    baseline,
    valueTicks,
    valueDecimals,
    band,
    xAt,
    valueAt,
    pointAt: (x, value) => (horizontal ? { x: valueAt(value), y: xAt(x) } : { x: xAt(x), y: valueAt(value) }),
    // Categories are the sample indices; numeric samples spread over the domain.
    sampleX: (series, index) => (count !== undefined ? index : (index / Math.max(1, series.values.length - 1)) * spread),
    plot,
  };
}

/** One bar of a bar chart, in viewBox units. */
export interface ChartBar {
  /** Which series, by index. */
  series: number;
  /** Which category. */
  index: number;
  value: number;
  rect: ViewRect;
  /** The bar's far end, mid-width, held inside the plot: the point a marker or a note's leader reaches. */
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
      // A bar past an explicit end of the domain is clipped at the plot's
      // edge, so its end is held there, as a line's point is.
      const reach = scales.valueAt(Math.min(scales.yMax, Math.max(scales.yMin, value)));
      bars.push({ series: seriesIndex, index, value, rect, end: scales.horizontal ? { x: reach, y: mid } : { x: mid, y: reach } });
    });
  });
  return bars;
}

/** The radius of a scatter chart's point markers, in viewBox units. */
export const CHART_POINT_RADIUS = 4;
/** The radius of the marker ring, and the width of its stroke, in viewBox units. */
export const CHART_MARKER_RADIUS = 5;
export const CHART_MARKER_STROKE = 2;

/** What a note laid over a chart keeps clear of: everything the chart draws, as it draws it, in viewBox units. */
export interface ChartObstacles {
  /** The marks drawn as areas, cut to the plot as its clip cuts them: each bar, each scatter point, the marker ring. */
  marks: ViewRect[];
  /** The line through each series of a line or an area chart; the plot's clip cuts what runs past it. */
  lines: ViewPoint[][];
  /**
   * An area chart's fill between each line and its baseline, as convex
   * pieces: one per segment, or two triangles where the segment crosses the
   * baseline. The plot's clip cuts what runs past it.
   */
  fills: ViewPoint[][];
  /** The legend, and the strips the axes' labels sit in. */
  labels: ViewRect[];
}

function cut(rect: ViewRect, clip: ViewRect): ViewRect | undefined {
  const inside = {
    left: Math.max(rect.left, clip.left),
    top: Math.max(rect.top, clip.top),
    right: Math.min(rect.right, clip.right),
    bottom: Math.min(rect.bottom, clip.bottom),
  };
  return inside.right > inside.left && inside.bottom > inside.top ? inside : undefined;
}

// The fill between a line and the baseline at `base`, segment by segment.
function areaPieces(line: ViewPoint[], base: number): ViewPoint[][] {
  const pieces: ViewPoint[][] = [];
  for (let index = 1; index < line.length; index += 1) {
    const a = line[index - 1];
    const b = line[index];
    const above = a.y - base;
    const below = b.y - base;
    if (above * below < 0) {
      const crossing = { x: a.x + ((b.x - a.x) * above) / (above - below), y: base };
      pieces.push([a, crossing, { x: a.x, y: base }], [crossing, b, { x: b.x, y: base }]);
    } else {
      pieces.push([a, b, { x: b.x, y: base }, { x: a.x, y: base }]);
    }
  }
  return pieces;
}

/**
 * Everything a note laid over the chart must keep off: a bar or a scatter
 * point is an area, not a line round it, so it is a mark; a line is the
 * line it draws; an area chart's fill is softer, a place to go only where
 * nothing else is free; and the legend and the axes' labels are read too.
 */
/**
 * The rect the chart clips its series and its marker to: the plot, grown
 * for a scatter chart by a point's radius and a unit, so a point on the
 * plot's edge is drawn whole.
 */
export function chartClip(scales: ChartScales): ViewRect {
  const reach = scales.kind === 'scatter' ? CHART_POINT_RADIUS + 1 : 0;
  const { plot } = scales;
  return { left: plot.left - reach, top: plot.top - reach, right: plot.right + reach, bottom: plot.bottom + reach };
}

export function chartObstacles(data: ChartData, scales: ChartScales = chartScales(data)): ChartObstacles {
  const { plot, kind } = scales;
  // What the chart's clip lets through: the bars, the points and the ring
  // are drawn inside it.
  const clip = chartClip(scales);
  const marks: ViewRect[] = [];
  const lines: ViewPoint[][] = [];
  const fills: ViewPoint[][] = [];
  if (kind === 'bar') {
    for (const bar of chartBars(data, scales)) {
      const rect = cut(bar.rect, clip);
      if (rect) marks.push(rect);
    }
  } else {
    const traces = data.series.map((series) => series.values.map((value, index) => scales.pointAt(scales.sampleX(series, index), value)));
    if (kind === 'scatter') {
      for (const point of traces.flat()) {
        const r = CHART_POINT_RADIUS;
        const rect = cut({ left: point.x - r, top: point.y - r, right: point.x + r, bottom: point.y + r }, clip);
        if (rect) marks.push(rect);
      }
    } else {
      lines.push(...traces);
      if (kind === 'area') {
        const base = scales.valueAt(scales.baseline);
        for (const line of traces) fills.push(...areaPieces(line, base));
      }
    }
  }
  const marker = data.marker ? chartSeriesPoint(data, data.marker.x, data.marker.series, scales) : undefined;
  if (marker) {
    const r = CHART_MARKER_RADIUS + CHART_MARKER_STROKE / 2;
    const ring = cut({ left: marker.x - r, top: marker.y - r, right: marker.x + r, bottom: marker.y + r }, clip);
    if (ring) marks.push(ring);
  }
  return { marks, lines, fills, labels: [chartLegendBox(data, scales.frame), ...chartAxisBoxes(plot, scales.frame)] };
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
export function chartLegendBox(data: ChartData, frame: ChartFrame = CHART_FRAME): ViewRect {
  const pad = chartPad(data, frame);
  const layout = chartLegendLayout(data, frame.width - pad.left - pad.right);
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
export function chartAxisBoxes(plot: ViewRect, frame: ChartFrame = CHART_FRAME): ViewRect[] {
  return [
    { left: 0, top: plot.top - 8, right: plot.left, bottom: plot.bottom + 8 },
    { left: plot.left - 20, top: plot.bottom, right: frame.width, bottom: frame.height },
  ];
}
