import type { ChartData, ChartKind, ChartSeries } from '../controller/types';
import { readableScale, type DrawingText } from './drawingFit';
import { hiddenTraceLength } from './notePlacement';

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
  // Whole units, rounded down so the slot draws them at the scale or more.
  return { width: Math.floor(slot.width / scale), height: Math.floor(slot.height / scale), scale };
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
// The most of the width those labels may take, three tenths of it: a
// longer one wraps (`wrapLabel`), so the bars keep the rest. A frame
// narrower than the approved canvas gives them the same share of its width.
export const CHART_CATEGORY_PAD_MAX = 300;
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
  return { text: `${name.slice(0, maxChars).trimEnd()}${CHART_ELLIPSIS}`, truncated: true };
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

/**
 * What a note's anchor names on a chart, in the chart's own words, as the
 * caller reads them -- never the object's id or a bare index: on a
 * labelled chart the category at its x (`FRONTEND VISUAL / THIS RUN`), on
 * any other the x axis's name and the value (`EPOCH 32 / VAL LOSS`), then
 * the series wherever the anchor names one or the chart draws more than
 * one. The series and the x are the ones the chart marks: a name the chart
 * does not carry is its first series, and an x past the domain its nearest
 * end. An anchor with no x names its series alone; undefined where it names
 * neither, or no point the chart can draw.
 */
export function chartTargetText(anchor: { x?: number; series?: string }, data: ChartData, scales: ChartScales = chartScales(data)): string | undefined {
  if (anchor.x === undefined) return data.series.find((candidate) => candidate.name === anchor.series)?.name;
  const sample = seriesSample(data, anchor.x, anchor.series, scales);
  if (!sample) return undefined;
  const series = anchor.series !== undefined || data.series.length > 1 ? ` / ${data.series[sample.series].name}` : '';
  const labels = data.labels;
  if (labels && labels.length > 0) return `${labels[Math.round(sample.x)]}${series}`;
  // A bar stands for its whole category, so it names that category's index.
  const x = scales.kind === 'bar' ? Math.round(sample.x) : sample.x;
  return `${data.xLabel ?? 'X'} ${String(Number(x.toPrecision(15)))}${series}`;
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
 * line breaks after a space, a path's separator or a dot, or inside a
 * camel-cased name before a capital, where it can; inside a word only where
 * a word alone is too long. A label that needs more lines is cut with an
 * ellipsis: at its start when it is a path (a slash and no space), whose
 * file name at the end is what tells it apart, else at its end.
 */
export function wrapLabel(label: string, width: number, lines: number): { text: string; lines: string[]; truncated: boolean } {
  const room = Math.max(2, width);
  if (label.length <= room) return { text: label, lines: [label], truncated: false };
  const pieces = labelPieces(label);
  const set = fill(pieces, room);
  if (set.length <= lines) return { text: label, lines: set.map((line) => line.trim()), truncated: false };
  if (label.includes('/') && !/\s/.test(label)) {
    // From the end: the pieces filled backward, the last lines kept, and
    // the first of them led by the ellipsis.
    const back = fill([...pieces].reverse(), room - 1, true).reverse().map((line) => line.trim());
    const kept = back.slice(-lines);
    kept[0] = `${CHART_ELLIPSIS}${kept[0]}`;
    return { text: kept.join(' '), lines: kept, truncated: true };
  }
  // The lines kept as set, and what the label says after them, cut.
  const kept = set.slice(0, lines - 1);
  const rest = label.slice(kept.reduce((sum, line) => sum + line.length, 0)).trim();
  const last = truncateLabel(rest, room * CHART_TICK_CHAR_ADVANCE, CHART_TICK_CHAR_ADVANCE).text;
  const shown = [...kept.map((line) => line.trim()), last];
  return { text: shown.join(' '), lines: shown, truncated: true };
}

// The pieces a line may end after: each run up to and including a space, a
// path's separator or a dot, or up to a capital that starts a word inside
// a camel-cased name (`note|Placement.|test.ts`).
function labelPieces(label: string): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (let index = 0; index < label.length; index += 1) {
    const char = label[index];
    const next = label[index + 1] ?? '';
    piece += char;
    const separator = /[\s/_.:-]/.test(char) && !/[\s/_.:-]/.test(next);
    const camel = /[a-z]/.test(char) && /[A-Z]/.test(next);
    if (separator || camel) {
      pieces.push(piece);
      piece = '';
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

// Pieces set on lines of at most `room` characters (spaces at a line's
// ends not counted), in order -- or, with `backward`, the pieces given last
// first, each line grown at its start. The lines keep their spaces, so in
// order they join back into the label.
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
      } else if (line.trim().length > 0) {
        set.push(line);
        line = '';
      } else if (backward) {
        set.push(rest.slice(-room) + line);
        rest = rest.slice(0, -room);
        line = '';
      } else {
        set.push(line + rest.slice(0, room));
        rest = rest.slice(room);
        line = '';
      }
    }
  }
  if (line.length > 0) {
    if (line.trim().length > 0 || set.length === 0) set.push(line);
    else set[set.length - 1] = backward ? line + set[set.length - 1] : set[set.length - 1] + line;
  }
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
    // holds, up to three, and is truncated only past them. The row is
    // judged with the legend as it wraps over the narrowest plot the label
    // column can leave, so the lines never outgrow it.
    const narrowest = chartLegendLayout(data, frame.width - categoryPadMax(frame) - CHART_PAD.right).rows;
    const rowsHeight = frame.height - CHART_PAD.top - legendRowsAbovePlot(kind, narrowest) * CHART_LEGEND_ROW_HEIGHT - CHART_PAD.bottom;
    const lines = Math.max(1, Math.min(CHART_CATEGORY_LINES, Math.floor(rowsHeight / count / CHART_TICK_ROW_HEIGHT)));
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
const CHART_HEADROOM = 0.1;
// About how many intervals a value axis is cut into, and the most ticks it
// is ever labelled at.
const CHART_VALUE_INTERVALS = 5;
const CHART_MAX_TICKS = 12;

// A round step -- 1, 2, 2.5 or 5 times a power of ten -- that cuts `span`
// into at most about `intervals` pieces.
function niceStep(span: number, intervals: number): number {
  const raw = span / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw * (1 - 1e-9)) ?? 10 * magnitude;
}

// How many decimals print a multiple of `step` exactly: 2 for 0.25, 0 for 50.
function decimalsOf(step: number): number {
  for (let decimals = 0; decimals < 20; decimals += 1) {
    const scaled = step * 10 ** decimals;
    if (Math.round(scaled) >= 1 && Math.abs(scaled - Math.round(scaled)) < 1e-6 * scaled) return decimals;
  }
  return 20;
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
  // Fifteen digits: a multiple of the step stays itself next to values as
  // large as epoch milliseconds.
  const precise = (value: number) => Number(value.toPrecision(15));
  let min = data.yMin ?? precise(Math.floor(reachLow / step + 1e-9) * step);
  let max = data.yMax ?? precise(Math.ceil(reachHigh / step - 1e-9) * step);
  // A flat series still gets a domain to stand in: a step either side of
  // a line, a step past the baseline for bars.
  if (max <= min) {
    if (data.yMax !== undefined) min = precise(max - step);
    else if (data.yMin !== undefined || grounded) max = precise(min + step);
    else {
      min = precise(min - step);
      max = precise(max + step);
    }
  }
  // The ticks by their index along the step, so there are always a few of
  // them; a domain whose step its magnitude drowns falls back to even
  // divisions.
  const first = Math.ceil(min / step - 1e-9);
  const count = Math.floor(max / step + 1e-9) - first + 1;
  if (!(count >= 1 && count <= CHART_MAX_TICKS) || !(max > min)) {
    const ticks = Array.from({ length: 4 }, (_, index) => max - ((max - min) * index) / 3);
    return { min, max, ticks, decimals: 2 };
  }
  const ticks = Array.from({ length: count }, (_, index) => precise((first + index) * step));
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

/** The side of a point a leader arrives from. */
export type ChartSide = 'above' | 'below' | 'left' | 'right';

/** A point on the chart something names: a marker, or a note's anchor. */
export interface ChartAnchor {
  x: number;
  series?: string;
}

/**
 * A bar marked as the one a marker or a note names: the bar itself is
 * outlined, its value printed past its end, and a leader to it lands just
 * past that value, from the bar's open end -- never along or through the
 * bar it means.
 */
export interface ChartBarCallout {
  bar: ChartBar;
  /** The value printed past the bar's end; inside its end where the plot has no room past it. */
  value: { text: string; x: number; y: number; anchor: 'start' | 'middle' | 'end'; inside: boolean };
  /** The printed value's box. */
  label: ViewRect;
  /** Where a leader to the bar lands. */
  point: ViewPoint;
  /** The side of `point` a leader comes from: past the bar's end. */
  from: ChartSide;
}

// The space between a bar's end and the value printed past it, and between
// that value and the end of a leader that names the bar.
const CALLOUT_GAP = 6;
const CALLOUT_LANDING = 3;
// The value is the tick text's face (13 units): about 10 units above its
// baseline, 3 below.
const CALLOUT_ASCENT = 10;
const CALLOUT_DESCENT = 3;

function calloutText(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * The callout for the bar at `x` in the named series (the first series for
 * a name the chart does not carry), or undefined on a chart that is not a
 * bar chart or has no bar there.
 */
export function chartBarCallout(data: ChartData, anchor: ChartAnchor, scales: ChartScales = chartScales(data)): ChartBarCallout | undefined {
  if (scales.kind !== 'bar' || !Number.isFinite(anchor.x)) return undefined;
  const named = anchor.series ? data.series.findIndex((candidate) => candidate.name === anchor.series) : -1;
  const which = named >= 0 ? named : 0;
  const last = (data.series[which]?.values.length ?? 0) - 1;
  if (last < 0) return undefined;
  const index = Math.round(Math.min(last, Math.max(0, anchor.x)));
  const bars = chartBars(data, scales);
  const bar = bars.find((candidate) => candidate.series === which && candidate.index === index);
  if (!bar) return undefined;
  const { plot, horizontal } = scales;
  const text = calloutText(bar.value);
  const width = text.length * CHART_TICK_CHAR_ADVANCE;
  const positive = bar.value >= scales.baseline;
  // Along the value axis (y upright, x across) the way the bar grows, and
  // across it the category axis.
  const grows = horizontal ? (positive ? 1 : -1) : positive ? -1 : 1;
  const valueOf = (point: ViewPoint) => (horizontal ? point.x : point.y);
  const mid = horizontal ? bar.end.y : bar.end.x;
  const span: [number, number] = horizontal ? [mid - 6, mid + 5] : [mid - width / 2, mid + width / 2];
  const size = horizontal ? width : CALLOUT_ASCENT + CALLOUT_DESCENT;
  const [low, high] = horizontal ? [plot.left, plot.right] : [plot.top, plot.bottom];
  const end = valueOf(bar.end);
  // Past the end of every bar on the same side that the value's text would
  // otherwise lie over: a grouped neighbour taller than the bar it names.
  let far = end;
  for (const other of bars) {
    const [from, to] = horizontal ? [other.rect.top, other.rect.bottom] : [other.rect.left, other.rect.right];
    if (other === bar || to <= span[0] || from >= span[1] || other.value >= scales.baseline !== positive) continue;
    far = grows > 0 ? Math.max(far, valueOf(other.end)) : Math.min(far, valueOf(other.end));
  }
  const outsideNear = far + grows * CALLOUT_GAP;
  const outsideFar = outsideNear + grows * size;
  const fitsOutside = grows > 0 ? outsideFar + CALLOUT_LANDING <= high : outsideFar - CALLOUT_LANDING >= low;
  // Inside the bar's end where the plot has no room past it, if the bar
  // holds the text.
  const length = horizontal ? bar.rect.right - bar.rect.left : bar.rect.bottom - bar.rect.top;
  const thickness = horizontal ? bar.rect.bottom - bar.rect.top : bar.rect.right - bar.rect.left;
  const holds = length >= size + 2 * CALLOUT_GAP && (horizontal || thickness + 4 >= width);
  const inside = !fitsOutside && holds;
  const near = inside ? end - grows * CALLOUT_GAP : outsideNear;
  const away = inside ? -grows : grows;
  const [from, to] = [Math.min(near, near + away * size), Math.max(near, near + away * size)];
  const label: ViewRect = horizontal ? { left: from, right: to, top: span[0], bottom: span[1] } : { left: span[0], right: span[1], top: from, bottom: to };
  const tip = (inside ? end : near + away * size) + grows * CALLOUT_LANDING;
  if (horizontal) {
    return {
      bar,
      value: { text, x: near, y: mid + 4.5, anchor: away > 0 ? 'start' : 'end', inside },
      label,
      point: { x: tip, y: mid },
      from: positive ? 'right' : 'left',
    };
  }
  return {
    bar,
    value: { text, x: mid, y: label.bottom - CALLOUT_DESCENT, anchor: 'middle', inside },
    label,
    point: { x: mid, y: tip },
    from: positive ? 'above' : 'below',
  };
}

/** The callouts a bar chart draws: its marker's bar and each bar a note names, once each. */
export function chartBarCallouts(data: ChartData, named: ChartAnchor[] = [], scales: ChartScales = chartScales(data)): ChartBarCallout[] {
  const callouts: ChartBarCallout[] = [];
  for (const anchor of [...(data.marker ? [data.marker] : []), ...named]) {
    const callout = chartBarCallout(data, anchor, scales);
    if (callout && !callouts.some((other) => other.bar === callout.bar || (other.bar.series === callout.bar.series && other.bar.index === callout.bar.index))) {
      callouts.push(callout);
    }
  }
  return callouts;
}

/**
 * Where a note's leader lands on the chart, the side it comes from, and
 * what it names there: on a bar chart the bar's callout point, past its
 * end, with the bar and its printed value; on a line, area or scatter
 * chart the point's callout, past the value printed beside its ring, with
 * the ring and the value. `named` is every point the notes on the chart
 * name, the anchor's among them: a point's value keeps clear of the
 * callouts before it, so where it is printed depends on them.
 */
export function chartNoteTarget(
  data: ChartData,
  anchor: ChartAnchor,
  scales: ChartScales = chartScales(data),
  named: ChartAnchor[] = [anchor],
): { point: ViewPoint; from: ChartSide; mark: ViewRect; value: ViewRect } | undefined {
  if (scales.kind === 'bar') {
    const callout = chartBarCallout(data, anchor, scales);
    return callout ? { point: callout.point, from: callout.from, mark: callout.bar.rect, value: callout.label } : undefined;
  }
  const sample = seriesSample(data, anchor.x, anchor.series, scales);
  if (!sample) return undefined;
  const callouts = chartPointCallouts(data, named.includes(anchor) ? named : [...named, anchor], scales);
  const callout = callouts.find((each) => each.series === sample.series && each.x === sample.x);
  return callout ? { point: callout.point, from: callout.from, mark: callout.ring, value: callout.label } : undefined;
}

/**
 * A point a marker or a note names on a line, area or scatter chart,
 * marked as a bar is: a ring round it, and its value printed beside the
 * ring on the side with the most clear room, where a leader to it lands --
 * the point is read off the value, as a bar is off its printed end.
 */
export interface ChartPointCallout {
  /** Which series, by index. */
  series: number;
  /** The domain x it stands at, held inside the series' domain. */
  x: number;
  /** The point on the drawn series, held inside the plot. */
  at: ViewPoint;
  /** The ring round it, stroke and all. */
  ring: ViewRect;
  /** The value printed beside the ring, as precise as the series' own values. */
  value: { text: string; x: number; y: number; anchor: 'start' | 'middle' | 'end' };
  /** The printed value's box. */
  label: ViewRect;
  /** Where a leader to the point lands: just past the value. */
  point: ViewPoint;
  /** The side of `point` a leader comes from: the side the value is printed on. */
  from: ChartSide;
}

// The space between a point's ring and the value printed beside it.
const POINT_VALUE_GAP = 4;
// How far past a point's value a clear run is looked for, where the
// leader's last run and a card come from: the side with more of it wins.
const POINT_ROOM = 120;

/** Where a point's value is printed: the side of its ring, and how the text runs from the ring's middle. */
interface PointSpot {
  side: ChartSide;
  /** Above or below the ring: centred on it, or starting or ending over it, clear of a line rising one way. */
  align: 'middle' | 'start' | 'end';
  /** What the spot costs before anything is in its way: the order it is preferred in where spots read alike. */
  order: number;
}

// Above the ring first, then below: a leader comes onto it straight down
// or up, the way it reaches a bar's end. Centred where that is clear, else
// running off to one side, clear of a line that rises the other way. Beside
// the ring costs more on a line, where the line itself runs: it wins only
// where above and below have much less room past them (a peak whose line
// falls away under it, a point on the plot's edge); a scatter's point has
// no line through it.
const POINT_SPOTS: PointSpot[] = [
  { side: 'above', align: 'middle', order: 0 },
  { side: 'below', align: 'middle', order: 4 },
  { side: 'above', align: 'end', order: 6 },
  { side: 'above', align: 'start', order: 6 },
  { side: 'below', align: 'end', order: 10 },
  { side: 'below', align: 'start', order: 10 },
  { side: 'right', align: 'start', order: 12 },
  { side: 'left', align: 'end', order: 12 },
];
// What beside the ring costs more on a line or an area, as units of room.
const POINT_BESIDE_LINE = 40;
// How far into the gap between the plot and its axes' tick text a point's
// value may run: the y ticks end 14 units short of the plot, the x ticks'
// text starts 24 below it.
const CALLOUT_TICK_GAP = 10;
// What printing an area's value over its own fill costs, as units of room:
// it stands past the line, outside its area, as a bar's stands past its end.
const POINT_OWN_FILL = 60;

// The value at a point, printed to the decimals the series' own values
// have (at most six): an interpolated value never prints longer than the
// data it was read from. A value too small for six decimals prints to
// three significant figures rather than as 0.
function pointValueText(values: number[], value: number): string {
  const decimalsOf = (each: number) => {
    let decimals = 0;
    while (decimals < 6 && Math.abs(each * 10 ** decimals - Math.round(each * 10 ** decimals)) > 1e-9 * Math.max(1, Math.abs(each * 10 ** decimals))) decimals += 1;
    return decimals;
  };
  const decimals = Math.max(0, ...values.filter((each) => Number.isFinite(each)).map(decimalsOf));
  const text = String(Number(value.toFixed(decimals)));
  return text === '0' && value !== 0 ? String(Number(value.toPrecision(3))) : text;
}

// A point's value printed at one spot by its ring, and where a leader to it
// lands: past the value, in line with the point.
function pointLabel(at: ViewPoint, spot: PointSpot, width: number): Pick<ChartPointCallout, 'value' | 'label' | 'point'> {
  const ring = CHART_MARKER_RADIUS + CHART_MARKER_STROKE / 2;
  const reach = ring + POINT_VALUE_GAP;
  const height = CALLOUT_ASCENT + CALLOUT_DESCENT;
  if (spot.side === 'above' || spot.side === 'below') {
    const top = spot.side === 'above' ? at.y - reach - height : at.y + reach;
    // Centred on the ring, or starting or ending over its edge.
    const left = spot.align === 'middle' ? at.x - width / 2 : spot.align === 'start' ? at.x - ring : at.x + ring - width;
    const label = { left, right: left + width, top, bottom: top + height };
    const x = spot.align === 'middle' ? at.x : spot.align === 'start' ? label.left : label.right;
    return {
      label,
      value: { text: '', x, y: label.bottom - CALLOUT_DESCENT, anchor: spot.align },
      point: { x: at.x, y: spot.side === 'above' ? label.top - CALLOUT_LANDING : label.bottom + CALLOUT_LANDING },
    };
  }
  const left = spot.side === 'right' ? at.x + reach : at.x - reach - width;
  // The text's middle on the point's height.
  const label = { left, right: left + width, top: at.y - height / 2, bottom: at.y + height / 2 };
  return {
    label,
    value: { text: '', x: spot.side === 'right' ? label.left : label.right, y: label.bottom - CALLOUT_DESCENT, anchor: spot.side === 'right' ? 'start' : 'end' },
    point: { x: spot.side === 'right' ? label.right + CALLOUT_LANDING : label.left - CALLOUT_LANDING, y: at.y },
  };
}

// How far from `start`, away from the point on `side`, the room past a
// point's value stays clear of the lines and the marks and inside the
// frame, up to `POINT_ROOM`: a run a few units across that widens at 45
// degrees to one side or the other -- the way a leader comes on, straight
// or after a 45-degree turn, from a card beyond it that is wider still --
// whichever side has more. A peak's value printed into the narrow wedge
// under its apex has little room; one printed over a gently rising line
// has all of it.
function roomPast(side: ChartSide, start: ViewPoint, lines: ViewPoint[][], marks: ViewRect[], frame: ChartFrame): number {
  return Math.max(roomToward(side, start, lines, marks, frame, 1), roomToward(side, start, lines, marks, frame, -1));
}

// `roomPast` with the run widening to one side: `flare` 1 towards larger x
// (or y, on a side to the left or right), -1 towards smaller.
function roomToward(side: ChartSide, start: ViewPoint, lines: ViewPoint[][], marks: ViewRect[], frame: ChartFrame, flare: 1 | -1): number {
  const half = 4;
  // A point in the wedge's own terms: how far along from `start`, and how far across.
  const along = (p: ViewPoint) => (side === 'above' ? start.y - p.y : side === 'below' ? p.y - start.y : side === 'left' ? start.x - p.x : p.x - start.x);
  const across = (p: ViewPoint) => flare * (side === 'above' || side === 'below' ? p.x - start.x : p.y - start.y);
  let room = Math.min(
    POINT_ROOM,
    Math.max(0, side === 'above' ? start.y : side === 'below' ? frame.height - start.y : side === 'left' ? start.x : frame.width - start.x),
  );
  // The nearest the segment a-b comes along inside the wedge (Liang-Barsky
  // against its four sides), if it enters it.
  const enter = (a: ViewPoint, b: ViewPoint) => {
    const [d0, d1] = [along(a), along(b)];
    const [c0, c1] = [across(a), across(b)];
    let t0 = 0;
    let t1 = 1;
    // Each side as g(t) = g0 + t * g1 <= 0.
    for (const [g0, g1] of [
      [-d0, -(d1 - d0)],
      [d0 - room, d1 - d0],
      [c0 - d0 - half, c1 - c0 - (d1 - d0)],
      [-c0 - half, -(c1 - c0)],
    ]) {
      if (g1 === 0) {
        if (g0 > 0) return;
        continue;
      }
      const t = -g0 / g1;
      if (g1 > 0) t1 = Math.min(t1, t);
      else t0 = Math.max(t0, t);
      if (t0 > t1) return;
    }
    room = Math.min(room, d0 + (d1 - d0) * t0, d0 + (d1 - d0) * t1);
  };
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) enter(line[index - 1], line[index]);
  }
  // The wedge's own bounds, in the frame's units, to pass over what lies wholly outside it.
  const reachOut = POINT_ROOM + half;
  const bounds = {
    left: start.x - (side === 'left' ? POINT_ROOM : reachOut),
    right: start.x + (side === 'right' ? POINT_ROOM : reachOut),
    top: start.y - (side === 'above' ? POINT_ROOM : reachOut),
    bottom: start.y + (side === 'below' ? POINT_ROOM : reachOut),
  };
  for (const mark of marks) {
    if (mark.right < bounds.left || mark.left > bounds.right || mark.bottom < bounds.top || mark.top > bounds.bottom) continue;
    if (mark.left <= start.x && start.x <= mark.right && mark.top <= start.y && start.y <= mark.bottom) return 0;
    const corners = [
      { x: mark.left, y: mark.top },
      { x: mark.right, y: mark.top },
      { x: mark.right, y: mark.bottom },
      { x: mark.left, y: mark.bottom },
    ];
    corners.forEach((corner, index) => enter(corner, corners[(index + 1) % 4]));
  }
  return Math.max(0, room);
}

/**
 * The callouts a line, area or scatter chart draws: its marker's point and
 * each point a note names, once each, in that order. Each prints its value
 * on the side of its ring that hides the least of the lines, the points,
 * the legend, the axis labels, the rings and the values before it, stays
 * on the frame, and leaves the most clear room past it for the leader that
 * lands there and the card it comes from. None on a bar chart, whose
 * callouts are its bars'.
 */
export function chartPointCallouts(data: ChartData, named: ChartAnchor[] = [], scales: ChartScales = chartScales(data)): ChartPointCallout[] {
  if (scales.kind === 'bar') return [];
  const { plot, frame } = scales;
  const clip = chartClip(scales);
  const traces = data.series.map((series) => series.values.map((value, index) => scales.pointAt(scales.sampleX(series, index), value)));
  const lines = scales.kind === 'scatter' ? [] : traces;
  const points =
    scales.kind === 'scatter'
      ? traces.flat().map((p) => ({ left: p.x - CHART_POINT_RADIUS, top: p.y - CHART_POINT_RADIUS, right: p.x + CHART_POINT_RADIUS, bottom: p.y + CHART_POINT_RADIUS }))
      : [];
  // What a value keeps off besides the data: the legend and the axes' tick
  // text, which ends 14 units short of the plot on the left and starts 24
  // below it, a gap a value by a ring on the plot's edge may take.
  const [ticksLeft, ticksBelow] = chartAxisBoxes(plot, frame);
  const labels = [
    chartLegendBox(data, frame),
    { ...ticksLeft, right: plot.left - CALLOUT_TICK_GAP },
    { ...ticksBelow, top: plot.bottom + CALLOUT_TICK_GAP * 2 },
  ];
  const reach = CHART_MARKER_RADIUS + CHART_MARKER_STROKE / 2;
  // Every point marked, once each, its ring first: a value keeps off every
  // ring, a later one's too.
  const marked: Array<{ sample: SeriesSample; at: ViewPoint; ring: ViewRect }> = [];
  for (const anchor of [...(data.marker ? [data.marker] : []), ...named]) {
    const sample = seriesSample(data, anchor.x, anchor.series, scales);
    if (!sample || marked.some((other) => other.sample.series === sample.series && other.sample.x === sample.x)) continue;
    const at = scales.pointAt(sample.x, Math.min(scales.yMax, Math.max(scales.yMin, sample.value)));
    marked.push({ sample, at, ring: { left: at.x - reach, top: at.y - reach, right: at.x + reach, bottom: at.y + reach } });
  }
  const callouts: ChartPointCallout[] = [];
  for (const { sample, at, ring } of marked) {
    const text = pointValueText(data.series[sample.series].values, sample.value);
    // An area's fill lies between its line and the baseline.
    const ownFill = scales.kind === 'area' ? (sample.value >= scales.baseline ? 'below' : 'above') : undefined;
    const width = text.length * CHART_TICK_CHAR_ADVANCE;
    // The values before this one and every other ring; every point but its
    // own, of those near enough to meet a value or the room past it.
    const taken = [...callouts.map((other) => other.label), ...marked.filter((other) => other.ring !== ring).map((other) => other.ring)];
    const within = POINT_ROOM + width + 2 * (reach + POINT_VALUE_GAP + CALLOUT_ASCENT + CALLOUT_DESCENT);
    const others = points.filter(
      (box) =>
        box.right > at.x - within && box.left < at.x + within && box.bottom > at.y - within && box.top < at.y + within &&
        !(box.left < at.x && at.x < box.right && box.top < at.y && at.y < box.bottom),
    );
    const inTheWay = [...others, ...taken, ...labels];
    let best: { callout: ChartPointCallout; cost: number } | undefined;
    for (const spot of POINT_SPOTS) {
      const { side } = spot;
      const { label, value, point } = pointLabel(at, spot, width);
      const near = { left: label.left - 2, top: label.top - 2, right: label.right + 2, bottom: label.bottom + 2 };
      const drawn = cut(near, clip);
      let cost = spot.order + (lines.length > 0 && (side === 'left' || side === 'right') ? POINT_BESIDE_LINE : 0);
      if (side === ownFill) cost += POINT_OWN_FILL;
      // The lines are drawn inside the plot's clip only.
      if (drawn) cost += hiddenTraceLength(drawn, lines) * 10;
      for (const box of others) cost += overlap(near, box);
      // The legend and the axes' labels, read as text, are kept clear of
      // as the data is; the band above the plot is free.
      for (const box of labels) cost += overlap(near, box) * 4;
      for (const box of taken) if (overlap(near, box) > 0) cost += 1e5;
      if (label.left < 0 || label.top < 0 || label.right > frame.width || label.bottom > frame.height) cost += 1e6;
      cost += POINT_ROOM - roomPast(side, point, lines, inTheWay, frame);
      if (!best || cost < best.cost) {
        best = { cost, callout: { series: sample.series, x: sample.x, at, ring, value: { ...value, text }, label, point, from: side } };
      }
    }
    callouts.push(best!.callout);
  }
  return callouts;
}

function area(rect: ViewRect | undefined): number {
  return rect ? (rect.right - rect.left) * (rect.bottom - rect.top) : 0;
}

function overlap(a: ViewRect, b: ViewRect): number {
  return area(cut(a, b));
}

/** The radius of a scatter chart's point markers, in viewBox units. */
export const CHART_POINT_RADIUS = 4;
/** The radius of the marker ring, and the width of its stroke, in viewBox units. */
export const CHART_MARKER_RADIUS = 5;
export const CHART_MARKER_STROKE = 2;

/** What a note laid over a chart keeps clear of: everything the chart draws, as it draws it, in viewBox units. */
export interface ChartObstacles {
  /**
   * The marks drawn as areas: each bar and each scatter point, cut to the
   * plot as its clip cuts them; and each callout's printed value -- a marked
   * point's ring too -- drawn whole past the plot's edge.
   */
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

export function chartObstacles(data: ChartData, scales: ChartScales = chartScales(data), named: ChartAnchor[] = []): ChartObstacles {
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
  if (kind === 'bar') {
    // A marked bar's printed value is read as part of it.
    for (const callout of chartBarCallouts(data, named, scales)) marks.push(callout.label);
  } else {
    // A marked point's ring and its printed value, drawn whole past the plot's edge.
    for (const callout of chartPointCallouts(data, named, scales)) marks.push(callout.ring, callout.label);
  }
  return { marks, lines, fills, labels: [chartLegendBox(data, scales.frame), ...chartAxisBoxes(plot, scales.frame)] };
}

/** A series' sample at a domain x, as a line chart draws it. */
interface SeriesSample {
  /** Which series, by index: a name the chart does not carry is its first. */
  series: number;
  /** The domain x, held inside the series' own domain. */
  x: number;
  /** The value interpolated there, as the data has it (not held to the plot). */
  value: number;
}

// The series named (its first, for a name the chart does not carry) at `x`,
// held inside its own domain, its value interpolated between the samples
// either side: undefined where there is no point to reach (a numeric chart
// with no positive x domain, a series with no values).
function seriesSample(data: ChartData, x: number, seriesName: string | undefined, scales: ChartScales): SeriesSample | undefined {
  const named = seriesName ? data.series.findIndex((candidate) => candidate.name === seriesName) : -1;
  const index = named >= 0 ? named : 0;
  const series = data.series[index];
  if (!series || series.values.length === 0 || !Number.isFinite(x)) return undefined;
  const categorical = scales.categories.categories !== undefined;
  if (!categorical && !(scales.xMax > 0)) return undefined;
  const last = series.values.length - 1;
  const domainX = Math.min(categorical ? last : scales.xMax, Math.max(0, x));
  const position = categorical ? domainX : (domainX / scales.xMax) * last;
  const lower = Math.floor(position);
  const upper = Math.min(last, lower + 1);
  const value = series.values[lower] + (series.values[upper] - series.values[lower]) * (position - lower);
  return { series: index, x: domainX, value };
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
  if (scales.kind === 'bar') {
    const sample = seriesSample(data, x, seriesName, scales);
    if (!sample) return undefined;
    const index = Math.round(sample.x);
    return chartBars(data, scales).find((candidate) => candidate.series === sample.series && candidate.index === index)?.end;
  }
  const sample = seriesSample(data, x, seriesName, scales);
  // Held inside the plot, as the drawn series is by its clip.
  return sample && scales.pointAt(sample.x, Math.min(scales.yMax, Math.max(scales.yMin, sample.value)));
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
