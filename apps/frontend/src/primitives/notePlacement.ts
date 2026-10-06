// Where the notes laid over a chart sit, and how each one's leader runs to
// the point it names. Pure geometry in one coordinate space (the note
// layer's CSS pixels), so the scene only measures and this decides.
//
// A note that names no point takes a corner; one that names a point centres
// over it. Either way a card first tries a row along the top or the bottom
// of the layer, and a later card takes the next row in, or the space beside
// an earlier one, rather than covering it. Among the places it tries each
// card takes the one that hides the least, in this order: never its own
// point or another note's, never another card, and never level with its own
// point, so that its leader leaves by the top or bottom border however
// short the chart; then never the data the chart draws -- a bar, a scatter
// point, a line, the marker ring, each a clearance away; then not so far
// along from its point that its leader runs a long way beside the card;
// then never the legend or the axis labels; then an area chart's fill only
// where nothing else is free; then as little as it can of the other notes'
// leaders, never running its own under another card, and as little of its
// own across the data; and, for a note with a point, as close over it as
// that allows.
//
// Where no row clears a card's point, the card also tries straight above
// and below the point, a gap away, and last beside it, level with it, so
// that its leader leaves by a side. It ends up beside its point only where
// each of those places above or below comes within 6px of the point, covers
// another note's point or overlaps another card. A card alone does so
// exactly when it is taller than the room above and below its point, less
// those 6px. Beside the point is still better than over it.
//
// A bar or a scatter point is an area, not the line round it: a card over
// the middle of a bar hides the bar. Where no place tried so far is clear,
// the card searches every place within reach of its point -- an empty
// stretch of the plot, or the free band above it inside the frame -- for
// one clear of all of that, then one over a fill at most, then one over
// fills and labels at most, never over the data.
//
// On a bar chart (`NoteField.wholly`) a card lies wholly inside the plot or
// wholly outside it, and a note naming a bar (`from`) is reached past the
// bar's end (`barLeader`): from a card past that end, or from one beside
// it, level with it -- the "never level" rule is for a line's points -- by
// a run along over the bars between. A place with no such route clear of
// the other bars ranks after one too far from its point and before one
// over the data. A card with no clear place, or a long way from its bar,
// tries the other sizes its note gives (`sizes`). On a line, area or
// scatter chart a card may lie across the plot's border, and its leader
// runs from the card's facing edge straight to the point on the drawn
// series (`routeLeader`), as the approved training goldens were drawn.
//
// A card is astray where its best place breaks one of these rules: over
// the data, too far from its point, with no clear leader to its bar, across
// a bar chart's plot border, level with its own point or skirting it, over
// another card or a named point. Given `spill`, where some card is astray
// and leaving one note out leaves fewer astray, that note is left out for
// the scene to show elsewhere (the rail): the one whose absence leaves the
// fewest astray; of those, a note naming no point first (it loses no leader
// in the rail), then one astray itself, then the one whose absence costs
// the others least. The others are placed without it. Without `spill`, or
// where no note's absence helps, each card takes the place that hides the
// least.

import { clipSegment, hiddenTraceLength, segmentsMeet, withoutRepeats, type Point, type Rect } from './segments';

export interface NoteToPlace {
  id: string;
  width: number;
  height: number;
  /** The point the note names, when it names one. */
  point?: Point;
  /** The side of the point its leader must come from (past a bar's end), when it matters. */
  from?: Side;
  /** The bar the point is past the end of: a leader never runs along its side. */
  bar?: Rect;
  /** The value the bar prints, beside the point: what its leader lands by, not in its way. */
  value?: Rect;
  /**
   * Narrower sizes the card may take, widest first, each with the height
   * its text needs there: tried, in turn, only where the card's own size
   * has no clear place or runs a long leader to its bar.
   */
  sizes?: Array<{ width: number; height: number }>;
}

/** The side of a point a leader comes from. */
export type Side = 'above' | 'below' | 'left' | 'right';

export interface NoteField {
  /** Where cards may sit: inside the panel's frame. */
  area: Rect;
  /** The plot's grid; the chart draws its lines and fills only inside it. */
  plot?: Rect;
  /** The lines the chart draws through its series: a line chart's, an area chart's edge. */
  traces?: Point[][];
  /** What the chart draws as areas, as drawn: each bar, each scatter point, its rings (`chartRings`), a bar's printed value. */
  marks?: Rect[];
  /** An area chart's fill under its line, as convex pieces: softer than the rest of the data. */
  fills?: Point[][];
  /** Legend and axis labels: kept clear like the data, but given up before it. */
  labels?: Rect[];
  /**
   * Every card lies wholly inside the plot or wholly outside it, never
   * across its border: a bar chart's, whose bars rise to that border.
   */
  wholly?: boolean;
}

/** Space kept between two cards, and between a card and the point it must not cover. */
export const NOTE_GAP = 10;

/** Space kept between a card and the data the chart draws, so a card never reads as resting on a bar. */
export const DATA_CLEARANCE = 6;

const COST = {
  ownPoint: 1e9,
  otherPoint: 1e8,
  cardOverlap: 1e7,
  straddle: 3e6,
  skirtingPoint: 2e6,
  noLeader: 1.5e6,
  levelWithPoint: 1e6,
  data: 5e5,
  far: 2e5,
  label: 1e5,
  fill: 5e4,
  cardOverlapArea: 100,
  farAlong: 10,
  traceLength: 40,
  markArea: 1,
  leaderLength: 80,
  labelArea: 0.5,
  fillArea: 0.05,
  leaderCrossing: 300,
  leaderThroughMark: 3,
  plotArea: 0.01,
  shift: 2.5,
  leader: 0.25,
  barLeader: 1,
  hug: 20,
  bottomRow: 60,
  rightCorner: 20,
};

const POINT_CLEARANCE = 6;

// How far from its point a card beside it sits: room for the leader to
// leave the card, step across and arrive.
const BESIDE_POINT = 24;

// How many places across its reach a card's search for a clear place
// tries at most, besides the edges of what is in its way.
const SEARCH_STEPS = 60;
// How far past the card's own span, as a share of its width, its point may
// lie for a place the search finds: further along, the leader would run a
// long way beside the card to reach it.
const SEARCH_REACH = 1 / 3;
// How close to one of the card's corners its leader may leave it (`routeLeader`'s inset).
const LEADER_INSET = 16;
// Past this many marks (a dense scatter), their edges are not tried one by
// one; the even steps across the layer still find the gaps between them.
const SEARCH_MARK_EDGES = 240;
// From this many marks, or line segments, on, they are bucketed by where
// they lie. A card is checked against every segment near it for every
// place tried, so a line's few dozen are bucketed already; the marks a card
// is checked against read faster one after another until they are many.
const MARKS_BUCKETED_FROM = 256;
const SEGMENTS_BUCKETED_FROM = 32;
// Past this many marks, a scatter is read as the area its points cover:
// each run of cells of a grid over the layer that they touch, along a row
// of it, stands for them, so the search reads hundreds of rects, not thousands.
const DENSE_MARKS = 1000;
const DENSE_GRID = 64;
// Past this many samples across its lines, a chart's lines are read as
// their envelope in this many strips across the layer.
const DENSE_SAMPLES = 1200;
const DENSE_COLUMNS = 96;

/** How a card that does not cover its point stands to it. */
type Standing = 'clear' | 'level' | 'skirting';

// What keeps a place from being clear, least first: an area chart's fill
// under it, the labels under it, its point further along than its leader
// should run, no route to its bar clear of the other bars, the data under
// it, and last everything that was always ruled out (its point, another's,
// another card, level with its point, across a bar chart's plot border).
// From `far` on, a card is astray.
const SHORT = { clear: 0, fill: 1, label: 2, far: 3, route: 3.5, data: 4, more: 5 } as const;

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function intersection(a: Rect, b: Rect): Rect | undefined {
  const rect = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return rect.right > rect.left && rect.bottom > rect.top ? rect : undefined;
}

function inflate(rect: Rect, by: number): Rect {
  return { left: rect.left - by, top: rect.top - by, right: rect.right + by, bottom: rect.bottom + by };
}

function covers(rect: Rect, point: Point, clearance = POINT_CLEARANCE): boolean {
  return (
    point.x > rect.left - clearance &&
    point.x < rect.right + clearance &&
    point.y > rect.top - clearance &&
    point.y < rect.bottom + clearance
  );
}

// Clear of the point above or below it, so the leader leaves by the top or
// bottom border; level with it, so the leader leaves by a side; or skirting
// it, within the clearance of the top or bottom border line, where a leader
// would run along the border. Asked only of a card that does not cover it.
function standing(rect: Rect, point: Point, clearance = POINT_CLEARANCE): Standing {
  if (point.y <= rect.top - clearance || point.y >= rect.bottom + clearance) return 'clear';
  return point.y >= rect.top + clearance && point.y <= rect.bottom - clearance ? 'level' : 'skirting';
}

// A convex polygon cut to an axis-aligned rect (Sutherland-Hodgman).
function clipPolygon(polygon: Point[], rect: Rect): Point[] {
  const sides: Array<[(p: Point) => number, (a: Point, b: Point) => Point]> = [
    [(p) => p.x - rect.left, (a, b) => ({ x: rect.left, y: a.y + ((b.y - a.y) * (rect.left - a.x)) / (b.x - a.x) })],
    [(p) => rect.right - p.x, (a, b) => ({ x: rect.right, y: a.y + ((b.y - a.y) * (rect.right - a.x)) / (b.x - a.x) })],
    [(p) => p.y - rect.top, (a, b) => ({ x: a.x + ((b.x - a.x) * (rect.top - a.y)) / (b.y - a.y), y: rect.top })],
    [(p) => rect.bottom - p.y, (a, b) => ({ x: a.x + ((b.x - a.x) * (rect.bottom - a.y)) / (b.y - a.y), y: rect.bottom })],
  ];
  let points = polygon;
  for (const [inside, cross] of sides) {
    if (points.length === 0) break;
    const next: Point[] = [];
    points.forEach((point, index) => {
      const previous = points[(index + points.length - 1) % points.length];
      const here = inside(point) >= 0;
      if (here !== inside(previous) >= 0) next.push(cross(previous, point));
      if (here) next.push(point);
    });
    points = next;
  }
  return points;
}

function polygonArea(points: Point[]): number {
  let twice = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    twice += point.x * next.y - next.x * point.y;
  });
  return Math.abs(twice) / 2;
}

/** How much of an area chart's fill a card at `rect` would hide, in square pixels. */
export function hiddenFillArea(rect: Rect, fills: Point[][]): number {
  let total = 0;
  for (const piece of fills) total += polygonArea(clipPolygon(piece, rect));
  return total;
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

function unique(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]) > 0.5);
}

// The polyline less its last `length` of run: a leader short of the point
// it arrives at, where it must meet the data it names.
function shortOfEnd(line: Point[], length: number): Point[] {
  let left = length;
  for (let index = line.length - 1; index > 0; index -= 1) {
    const a = line[index - 1];
    const b = line[index];
    const run = Math.hypot(b.x - a.x, b.y - a.y);
    if (run > left) {
      const share = (run - left) / run;
      return [...line.slice(0, index), { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share }];
    }
    left -= run;
  }
  return [];
}

/** Options for `layoutNotes`. */
export interface PlaceOptions {
  /** Space kept between two cards, and between a card and the point it must not cover. */
  gap?: number;
  /**
   * The scene can show one note elsewhere (the rail). Where some card is
   * astray and leaving one note out leaves fewer astray, that note is left
   * out, its card not placed: the one whose absence leaves the fewest
   * astray; of those a note naming no point first, then one astray itself,
   * then the cheapest for the others. Its point still stands in the other
   * cards' way.
   */
  spill?: boolean;
  /** How far inside a card's border a bar's leader begins, so it grows out of the border as drawn. */
  leaderOverlap?: number;
}

interface Placement {
  rect: Rect;
  cost: number;
  /** The worst of `SHORT` the place falls short by. */
  falls: number;
  /** It breaks a rule a card keeps: it falls short by `far` or worse. */
  astray: boolean;
  /** The leader from the card to its point; empty for a note that names none. */
  leader: Point[];
}

/** Where `layoutNotes` puts a note: its card, the leader it runs, and whether a narrower card could do better. */
export interface NotePlace {
  rect: Rect;
  leader: Point[];
  /**
   * Nothing the placement keeps a card off is under it, and a leader to a
   * bar is short: no narrower size of the card is worth trying.
   */
  settled: boolean;
}

// A leader to a bar longer than this has a narrower card try for a nearer
// place, and takes it if it saves this much more.
const BAR_LEADER_SHORT = 100;
const BAR_LEADER_SAVING = 60;
// The narrowest share of its own width a card takes only to run a shorter leader.
const BAR_LEADER_NARROWEST = 0.6;

function isSettled(note: NoteToPlace, placement: Placement): boolean {
  return placement.falls === SHORT.clear && (note.from === undefined || polylineLength(placement.leader) <= BAR_LEADER_SHORT);
}

/**
 * Places each note's card in the field, in the order given except that the
 * notes naming no point go first: they settle into the corners, and the
 * notes naming a point then sit as near their points as the corners leave,
 * with leaders no card covers. Returns each card's place by note id -- its
 * box, the leader it runs to its point, and whether it is settled; with
 * `spill`, the one note it leaves out has none.
 */
export function layoutNotes(notes: NoteToPlace[], field: NoteField, options: PlaceOptions = {}): Map<string, NotePlace> {
  const gap = options.gap ?? NOTE_GAP;
  const prepared = prepare(field, options.leaderOverlap);
  const all = placeInOrder(notes, prepared, gap);
  const over = (placements: Map<string, Placement>) => [...placements.values()].filter((placement) => placement.astray).length;
  let chosen = all;
  if (options.spill && over(all) > 0) {
    // A note leaves only where its absence leaves fewer cards astray: the
    // rail is for a card the chart has no place for, never to make room
    // for nothing. Of those, the one whose absence leaves the fewest astray;
    // then a note that names no point, which loses no leader in the rail;
    // then one that was astray itself; then the cheapest for the others.
    const better = (a: number[], b: number[]) => {
      const index = a.findIndex((value, at) => Math.abs(value - b[at]) > 1e-6);
      return index >= 0 && a[index] < b[index];
    };
    let best: { placements: Map<string, Placement>; rank: number[] } | undefined;
    for (const note of notes) {
      const placements = placeInOrder(notes, prepared, gap, note.id, all);
      const astray = over(placements);
      if (astray >= over(all)) continue;
      const rank = [
        astray,
        note.point ? 1 : 0,
        all.get(note.id)!.astray ? 0 : 1,
        [...placements.values()].reduce((sum, placement) => sum + placement.cost, 0),
      ];
      if (!best || better(rank, best.rank)) best = { placements, rank };
    }
    if (best) chosen = best.placements;
  }
  return new Map(
    [...chosen].map(([id, placement]) => [id, { rect: placement.rect, leader: placement.leader, settled: isSettled(notes.find((note) => note.id === id)!, placement) }]),
  );
}

// The cells of a grid over `area` that the marks touch, a run of them
// along each row as one rect: what a dense scatter covers, a little more
// generously than its points do.
function covered(marks: Rect[], area: Rect): Rect[] {
  const width = Math.max(1, area.right - area.left) / DENSE_GRID;
  const height = Math.max(1, area.bottom - area.top) / DENSE_GRID;
  const cell = (value: number, from: number, size: number) => clamp(Math.floor((value - from) / size), 0, DENSE_GRID - 1);
  const touched = new Uint8Array(DENSE_GRID * DENSE_GRID);
  for (const mark of marks) {
    if (mark.right < area.left || mark.left > area.right || mark.bottom < area.top || mark.top > area.bottom) continue;
    for (let row = cell(mark.top, area.top, height); row <= cell(mark.bottom, area.top, height); row += 1) {
      for (let column = cell(mark.left, area.left, width); column <= cell(mark.right, area.left, width); column += 1) {
        touched[row * DENSE_GRID + column] = 1;
      }
    }
  }
  const runs: Rect[] = [];
  for (let row = 0; row < DENSE_GRID; row += 1) {
    for (let column = 0; column < DENSE_GRID; column += 1) {
      if (!touched[row * DENSE_GRID + column]) continue;
      const start = column;
      while (column + 1 < DENSE_GRID && touched[row * DENSE_GRID + column + 1]) column += 1;
      runs.push({
        left: area.left + start * width,
        top: area.top + row * height,
        right: area.left + (column + 1) * width,
        bottom: area.top + (row + 1) * height,
      });
    }
  }
  return runs;
}

// A line with more samples than the layer has room to tell apart, as the
// envelope it draws: in each of `columns` strips across the layer, its
// lowest sample and its highest, in order along it. A card kept off the
// envelope is kept off the line; only the clearance it keeps from the line
// may come out a little narrower than from the envelope. Reading it costs a
// fraction.
function envelope(trace: Point[], area: Rect, columns: number): Point[] {
  const width = Math.max(1, area.right - area.left) / columns;
  const out: Point[] = [];
  let index = 0;
  while (index < trace.length) {
    const strip = Math.floor((trace[index].x - area.left) / width);
    let low = trace[index];
    let high = trace[index];
    while (index < trace.length && Math.floor((trace[index].x - area.left) / width) === strip) {
      if (trace[index].y < low.y) low = trace[index];
      if (trace[index].y > high.y) high = trace[index];
      index += 1;
    }
    out.push(...(low === high ? [low] : low.x <= high.x ? [low, high] : [high, low]));
  }
  return out;
}

// What lies in the field, bucketed by where it lies, so a question about
// one stretch of the layer reads only what lies near it: a scatter can
// carry thousands of points. Calls `visit` once for each item whose box
// meets `near`'s buckets (a superset of those that meet `near` itself).
function bucketed<T>(items: T[], boxOf: (item: T) => Rect, area: Rect, from: number): (near: Rect, visit: (item: T) => void) => void {
  // A few are read faster one after another than through the buckets.
  if (items.length <= from) return (_near, visit) => items.forEach((item) => visit(item));
  const across = 32;
  const width = Math.max(1, area.right - area.left) / across;
  const height = Math.max(1, area.bottom - area.top) / across;
  const column = (x: number) => clamp(Math.floor((x - area.left) / width), 0, across - 1);
  const row = (y: number) => clamp(Math.floor((y - area.top) / height), 0, across - 1);
  const buckets: number[][] = Array.from({ length: across * across }, () => []);
  items.forEach((item, index) => {
    const box = boxOf(item);
    for (let c = column(box.left); c <= column(box.right); c += 1) {
      for (let r = row(box.top); r <= row(box.bottom); r += 1) buckets[c * across + r].push(index);
    }
  });
  const seen = new Uint32Array(items.length);
  let stamp = 0;
  return (near, visit) => {
    stamp += 1;
    for (let c = column(near.left); c <= column(near.right); c += 1) {
      for (let r = row(near.top); r <= row(near.bottom); r += 1) {
        for (const index of buckets[c * across + r]) {
          if (seen[index] === stamp) continue;
          seen[index] = stamp;
          visit(items[index]);
        }
      }
    }
  };
}

// The field as the placement reads it, worked out once for every run of
// `placeInOrder`: a dense line as its envelope, a dense scatter as the area
// it covers, the lines as segments cut to the plot, and both bucketed.
interface Prepared {
  area: Rect;
  plot?: Rect;
  wholly: boolean;
  leaderOverlap: number;
  marks: Rect[];
  fills: Point[][];
  labels: Rect[];
  segmentsNear: (near: Rect, visit: (segment: [Point, Point]) => void) => void;
  marksNear: (near: Rect, visit: (mark: Rect) => void) => void;
}

function prepare(field: NoteField, leaderOverlap = 0): Prepared {
  const { area, plot } = field;
  const sampled = (field.traces ?? []).reduce((sum, trace) => sum + trace.length, 0);
  const traces = sampled > DENSE_SAMPLES ? (field.traces ?? []).map((trace) => envelope(trace, area, DENSE_COLUMNS)) : (field.traces ?? []);
  const marks = (field.marks ?? []).length > DENSE_MARKS ? covered(field.marks!, area) : (field.marks ?? []);
  // The segments of the lines, cut to the plot, where the chart draws them.
  const segments: Array<[Point, Point]> = [];
  for (const trace of traces) {
    for (let index = 1; index < trace.length; index += 1) {
      const a = trace[index - 1];
      const b = trace[index];
      const share = plot ? clipSegment(a, b, plot) : [0, 1];
      if (!share) continue;
      const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      segments.push([at(share[0]), at(share[1])]);
    }
  }
  return {
    area,
    plot,
    wholly: field.wholly === true,
    leaderOverlap,
    marks,
    fills: field.fills ?? [],
    labels: field.labels ?? [],
    segmentsNear: bucketed(
      segments,
      ([a, b]) => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) }),
      area,
      SEGMENTS_BUCKETED_FROM,
    ),
    marksNear: bucketed(marks, (mark) => mark, area, MARKS_BUCKETED_FROM),
  };
}

// Places the notes one by one, all of them but `leftOut`. Placed again
// without the note the rail takes, the cards placed before it in `before`,
// the run with every note, would take the same places, and every card
// after it that was not astray there keeps its place: the note left out
// only frees room, so that place is still clear, and a card that has a
// place does not move for a note that leaves. The cards after it that were
// astray are placed again, in order, around them: the first of them tries
// its sizes afresh, since the room the note left is its to take first (a
// general note's corner, say, may be what kept it from a clear place); the
// rest keep the size they took, so a crowded chart's reruns stay cheap.
function placeInOrder(
  notes: NoteToPlace[],
  field: Prepared,
  gap: number,
  leftOut?: string,
  before?: Map<string, Placement>,
): Map<string, Placement> {
  const { area, plot, marks, fills, labels, segmentsNear, marksNear, wholly, leaderOverlap } = field;
  const everyNote = [...notes.filter((note) => !note.point), ...notes.filter((note) => note.point)];
  const order = everyNote.filter((note) => note.id !== leftOut);
  const earlier = new Set(before ? everyNote.slice(0, Math.max(0, everyNote.findIndex((note) => note.id === leftOut))).map((note) => note.id) : []);
  const points = notes.flatMap((note) => (note.point ? [{ id: note.id, point: note.point }] : []));
  const placed = new Map<string, Placement>();
  const leaders: Point[][] = [];
  // The chart draws its lines and fills inside the plot only.
  const drawn = (rect: Rect) => (plot ? intersection(rect, plot) : rect);
  const lineUnder = (rect: Rect) => {
    let length = 0;
    segmentsNear(rect, ([a, b]) => {
      const share = clipSegment(a, b, rect);
      if (share) length += Math.hypot(b.x - a.x, b.y - a.y) * (share[1] - share[0]);
    });
    return length;
  };

  for (const note of order) {
    const kept = before?.get(note.id);
    if (kept && (earlier.has(note.id) || !kept.astray)) {
      placed.set(note.id, kept);
      if (kept.leader.length > 0) leaders.push(kept.leader);
    }
  }
  let first = true;
  for (const note of order) {
    if (placed.has(note.id)) continue;
    // The card at its own size; where that has no clear place, or runs a
    // long leader to its bar, each narrower size it may take, kept only
    // where it falls short by less -- or, as clear, runs a leader much
    // shorter.
    const sized = before && !first ? before.get(note.id)?.rect : undefined;
    first = false;
    let chosen = sized ? placeSized(note, sized.right - sized.left, sized.bottom - sized.top) : placeSized(note, note.width, note.height);
    for (const size of sized ? [] : (note.sizes ?? [])) {
      if (isSettled(note, chosen)) break;
      const trial = placeSized(note, size.width, size.height);
      // Shorter by enough to be worth the lines it costs, and never for a
      // card cut to a column.
      const shorter =
        note.from !== undefined &&
        size.width >= note.width * BAR_LEADER_NARROWEST &&
        polylineLength(trial.leader) < Math.min(polylineLength(chosen.leader) - BAR_LEADER_SAVING, polylineLength(chosen.leader) * 0.6);
      if (trial.falls < chosen.falls || (trial.falls === chosen.falls && shorter)) chosen = trial;
    }
    placed.set(note.id, chosen);
    if (chosen.leader.length > 0) leaders.push(chosen.leader);
  }
  return placed;

  function placeSized(note: NoteToPlace, width: number, height: number): Placement {
    const { point, from } = note;
    const others = [...placed.values()].map((placement) => placement.rect);
    const minLeft = area.left;
    const maxLeft = area.right - width;
    const minTop = area.top;
    const maxTop = area.bottom - height;

    const clampLeft = (left: number) => clamp(left, minLeft, maxLeft);
    const clampTop = (top: number) => clamp(top, minTop, maxTop);
    const lefts = unique(
      [
        ...(point ? [point.x - width / 2] : [minLeft, maxLeft]),
        ...[...others, ...labels].flatMap((other) => [other.left - gap - width, other.right + gap]),
      ].map(clampLeft),
    );
    const tops = unique(
      [minTop, maxTop, ...[...others, ...labels].flatMap((other) => [other.bottom + gap, other.top - gap - height])].map(clampTop),
    );

    let best: Placement | undefined;
    const consider = (atLeft: number, atTop: number) => {
      // A card with a bar's leader is scored where it will be drawn, on
      // whole pixels, so the leader it is scored by is the one drawn.
      const left = from ? Math.round(atLeft) : atLeft;
      const top = from ? Math.round(atTop) : atTop;
      const rect = { left, top, right: left + width, bottom: top + height };
      let cost = 0;
      let falls: number = SHORT.clear;
      if (point && covers(rect, point)) cost += COST.ownPoint;
      else if (point && !from) {
        const stands = standing(rect, point);
        if (stands === 'skirting') cost += COST.skirtingPoint;
        else if (stands === 'level') cost += COST.levelWithPoint;
      }
      for (const other of points) {
        if (other.id !== note.id && covers(rect, other.point)) cost += COST.otherPoint;
      }
      for (const other of others) {
        const area = overlapArea(rect, other);
        if (area > 0) cost += COST.cardOverlap + area * COST.cardOverlapArea;
      }
      if (wholly && plot && straddles(rect, plot, gap)) cost += COST.straddle;
      if (cost > 0) falls = SHORT.more;
      // Places rank by what they fall short by, then by cost. Neither ever
      // falls as more is added up, so a place already behind the best so
      // far cannot win -- and need not be routed.
      const beaten = () => best !== undefined && (falls > best.falls || (falls === best.falls && cost >= best.cost - 1e-6));
      if (beaten()) return;
      // A point on a line, its leader free to leave the card anywhere along
      // its facing edge: further along from the card than the leader should
      // run beside it.
      const freeAlong = point && !from ? Math.max(0, left + LEADER_INSET - point.x, point.x - (left + width - LEADER_INSET)) - width * SEARCH_REACH : 0;
      if (freeAlong > 0) {
        cost += COST.far + freeAlong * COST.farAlong;
        falls = Math.max(falls, SHORT.far);
      }
      if (beaten()) return;
      // The data, a clearance away: the lines and the marks the chart draws.
      const near = inflate(rect, DATA_CLEARANCE);
      const line = lineUnder(near);
      let mark = 0;
      marksNear(near, (each) => {
        mark += overlapArea(near, each);
      });
      const data = line > 0 || mark > 0;
      if (data) {
        cost += COST.data + line * COST.traceLength + mark * COST.markArea;
        falls = Math.max(falls, SHORT.data);
      }
      let label = 0;
      for (const each of labels) label += overlapArea(rect, each);
      if (label > 0) {
        cost += COST.label + label * COST.labelArea;
        falls = Math.max(falls, SHORT.label);
      }
      if (beaten()) return;
      const rectDrawn = drawn(rect);
      const fill = rectDrawn && fills.length > 0 ? hiddenFillArea(rectDrawn, fills) : 0;
      if (fill > 0.5) {
        cost += COST.fill + fill * COST.fillArea;
        falls = Math.max(falls, SHORT.fill);
      }
      cost += hiddenTraceLength(rect, leaders) * COST.leaderLength;
      if (beaten()) return;
      // What the place costs whatever its leader: its share of the plot, a
      // row low on the layer, a corner on the right; and for a point on a
      // line, how far off centre over it the card sits, how long its leader
      // runs, and a leader so short its first turn hugs the border it leaves.
      if (plot) cost += overlapArea(rect, plot) * COST.plotArea;
      const nearTop = top - minTop <= maxTop - top;
      if (!nearTop) cost += COST.bottomRow;
      if (point && !from) {
        cost += Math.abs(left + width / 2 - point.x) * COST.shift;
        const leaderLength = point.y >= rect.bottom ? point.y - rect.bottom : point.y <= rect.top ? rect.top - point.y : 0;
        cost += leaderLength * COST.leader;
        // Nearer than a gap, a leader's first turn hugs the border it leaves.
        if (leaderLength > 0) cost += Math.max(0, gap - leaderLength) * COST.hug;
      } else if (!point && left - minLeft > maxLeft - left) {
        cost += COST.rightCorner;
      }
      if (beaten()) return;
      // A bar's leader comes from past the bar's end, clear of every other
      // bar; a place with no such route has no leader that reads, which is
      // still better than a place over the data. Routing is what costs, so
      // it comes last, and a place whose leader would lose on the straight
      // distance to its point alone is never routed.
      const routed = point !== undefined && from !== undefined && !covers(rect, point);
      if (routed && best) {
        const least = Math.hypot(Math.max(rect.left - point.x, 0, point.x - rect.right), Math.max(rect.top - point.y, 0, point.y - rect.bottom));
        const past = least - farRun(width);
        const leastFalls = past > 0 ? Math.max(falls, SHORT.far) : falls;
        const leastCost = cost + least * COST.barLeader + (past > 0 ? COST.far + past * COST.farAlong : 0);
        if (leastFalls > best.falls || (leastFalls === best.falls && leastCost >= best.cost - 1e-6)) return;
      }
      const route = routed ? barLeader(rect, point, from, marksNear, { bar: note.bar, value: note.value, overlap: leaderOverlap }) : undefined;
      if (route && !route.clear) {
        cost += COST.noLeader;
        falls = Math.max(falls, SHORT.route);
      }
      // A bar's leader longer than it should run at all.
      const along = route ? polylineLength(route.path) - farRun(width) : 0;
      if (along > 0) {
        cost += COST.far + along * COST.farAlong;
        falls = Math.max(falls, SHORT.far);
      }
      if (route) {
        // A bar's leader is as short as it can be: beside the bar or over it.
        cost += polylineLength(route.path) * COST.barLeader;
      }
      if (beaten()) return;
      const leader = route ? route.path : point ? routeLeader(rect, point) : [];
      if (point) {
        for (const other of others) cost += hiddenTraceLength(other, [leader]) * COST.leaderLength;
        // A leader that runs over the data reads as part of it: across a
        // line, or through a bar, short of the point where it must meet it.
        const short = shortOfEnd(leader, DATA_CLEARANCE + 2);
        for (let index = 1; index < short.length; index += 1) {
          const a = short[index - 1];
          const b = short[index];
          const span = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
          segmentsNear(span, ([c, d]) => {
            if (segmentsMeet(a, b, c, d)) cost += COST.leaderCrossing;
          });
          marksNear(span, (each) => {
            cost += hiddenTraceLength(each, [[a, b]]) * COST.leaderThroughMark;
          });
        }
      }
      if (!best || falls < best.falls || (falls === best.falls && cost < best.cost - 1e-6)) {
        best = { rect, cost, falls, astray: falls >= SHORT.far, leader };
      }
    };

    // Every place a card spanning `left` can sit clear of what stands in
    // its way there -- its point's band, the other points and cards, the
    // data a clearance away, and the labels and the fills unless `through`
    // lets the card over them -- with the lefts it tries within reach of
    // its point, so its leader never runs far along to it.
    const search = (through: number) => {
      const blocks = (rect: Rect, left: number, right: number) => rect.left < right && rect.right > left;
      // A bar's leader may run beside the card to it, as far as reads.
      const reach = from ? farRun(width) : width * SEARCH_REACH;
      const low = point ? Math.max(minLeft, point.x - width + (from ? 0 : LEADER_INSET) - reach) : minLeft;
      const high = point ? Math.min(maxLeft, point.x - (from ? 0 : LEADER_INSET) + reach) : maxLeft;
      if (high < low) return;
      const markEdges = marks.length <= SEARCH_MARK_EDGES ? marks.map((mark) => inflate(mark, DATA_CLEARANCE)) : [];
      const step = Math.max(1, (high - low) / SEARCH_STEPS);
      const candidates = [
        low,
        high,
        ...Array.from({ length: Math.floor((high - low) / step) }, (_, index) => low + (index + 1) * step),
        ...(point ? [point.x - width / 2] : []),
        ...[...others.map((other) => inflate(other, gap)), ...markEdges, ...labels, ...(plot ? [plot] : [])].flatMap((rect) => [
          rect.left - width,
          rect.right,
        ]),
        // Wholly inside the plot or wholly beside it.
        ...(wholly && plot ? [plot.left + PLOT_INSET, plot.right - PLOT_INSET - width, plot.left - gap - width, plot.right + gap] : []),
        ...(from && point ? [point.x - BAR_NEAR - width, point.x + BAR_NEAR] : []),
      ];
      for (const left of unique(candidates.filter((left) => left >= low && left <= high))) {
        const right = left + width;
        const blocked: Array<[number, number]> = [];
        // Its own point's band: a place clear of the point's height by the
        // clearance `standing` asks for, so its leader leaves by the top or
        // bottom border.
        if (point && !from) blocked.push([point.y - POINT_CLEARANCE, point.y + POINT_CLEARANCE]);
        if (wholly && plot && !(right <= plot.left - gap || left >= plot.right + gap)) {
          // Across the plot's span a card keeps to one side of its border:
          // inside it, or above or below it.
          if (left >= plot.left + PLOT_INSET && right <= plot.right - PLOT_INSET) {
            blocked.push([plot.top - gap, plot.top + PLOT_INSET], [plot.bottom - PLOT_INSET, plot.bottom + gap]);
          } else {
            blocked.push([plot.top - gap, plot.bottom + gap]);
          }
        }
        for (const other of points) {
          if (other.id !== note.id && other.point.x > left - POINT_CLEARANCE && other.point.x < right + POINT_CLEARANCE) {
            blocked.push([other.point.y - POINT_CLEARANCE, other.point.y + POINT_CLEARANCE]);
          }
        }
        for (const other of others) if (blocks(other, left - gap, right + gap)) blocked.push([other.top - gap, other.bottom + gap]);
        const slab = { left: left - DATA_CLEARANCE, right: right + DATA_CLEARANCE, top: area.top - DATA_CLEARANCE, bottom: area.bottom + DATA_CLEARANCE };
        marksNear(slab, (mark) => {
          if (blocks(mark, slab.left, slab.right)) blocked.push([mark.top - DATA_CLEARANCE, mark.bottom + DATA_CLEARANCE]);
        });
        segmentsNear(slab, ([a, b]) => {
          const share = clipSegment(a, b, { ...slab, top: -Infinity, bottom: Infinity });
          if (!share) return;
          const y0 = a.y + (b.y - a.y) * share[0];
          const y1 = a.y + (b.y - a.y) * share[1];
          blocked.push([Math.min(y0, y1) - DATA_CLEARANCE, Math.max(y0, y1) + DATA_CLEARANCE]);
        });
        if (through < SHORT.label) {
          for (const label of labels) if (blocks(label, left, right)) blocked.push([label.top, label.bottom]);
        }
        const fillSlab = drawn({ left, right, top: -Infinity, bottom: Infinity });
        if (through < SHORT.fill && fillSlab) {
          for (const piece of fills) {
            const inside = clipPolygon(piece, fillSlab);
            if (polygonArea(inside) <= 0.5) continue;
            blocked.push([Math.min(...inside.map((p) => p.y)), Math.max(...inside.map((p) => p.y))]);
          }
        }
        blocked.sort((a, b) => a[0] - b[0]);
        // The free runs between what stands in the way, each tried at its
        // ends and wherever the cost turns: a gap from the point, where the
        // leader stops hugging the border, and at the plot's edges.
        let free = minTop;
        const runs: Array<[number, number]> = [];
        for (const [start, end] of blocked) {
          if (start > free) runs.push([free, Math.min(start, area.bottom)]);
          free = Math.max(free, end);
        }
        if (area.bottom > free) runs.push([free, area.bottom]);
        for (const [start, end] of runs) {
          // Half a pixel clear of what bounds the run, where something does.
          const first = start > minTop ? start + 0.5 : start;
          const last = end < area.bottom ? end - 0.5 - height : end - height;
          if (last < first) continue;
          const turns = [
            first,
            last,
            ...(point ? [point.y + gap, point.y - gap - height] : []),
            ...(plot ? [plot.top - height, plot.top, plot.bottom - height, plot.bottom] : []),
            ...(wholly && plot ? [plot.top - gap - height, plot.top + PLOT_INSET, plot.bottom - PLOT_INSET - height, plot.bottom + gap] : []),
            // Near enough a bar's point for its leader's last run onto it.
            ...(from && point ? [point.y - BAR_NEAR - height, point.y + BAR_NEAR] : []),
          ];
          for (const top of unique(turns.filter((top) => top >= first && top <= last))) consider(left, top);
        }
      }
    };

    for (const left of lefts) {
      for (const top of tops) consider(left, top);
    }
    if (point && best!.falls === SHORT.more) {
      // No row clears the point (each covers it or another card, is level
      // with it, or lies across a bar chart's plot border): straight above
      // or below it, a gap away, and last beside it, level with it. The
      // search below keeps to places clear of the data, so where nothing
      // within reach is clear these are what keeps a card off its point and
      // the border, over the data at worst (notePlacement.test.ts, "a card
      // with no clear place within reach of its point").
      for (const top of unique([point.y - gap - height, point.y + gap].map(clampTop))) {
        for (const left of lefts) consider(left, top);
      }
      const besideTop = clampTop(point.y - height / 2);
      for (const left of unique([point.x - BESIDE_POINT - width, point.x + BESIDE_POINT].map(clampLeft))) consider(left, besideTop);
    }
    // None of those is clear: anywhere within reach clear of everything,
    // then over a fill at most, then over fills and labels at most, never
    // over the data. A place that falls short only as far as a search lets
    // one still has the search look for a nearer one, and a clear place a
    // long way from its bar still has the search look for a nearer one.
    for (const through of [SHORT.clear, SHORT.fill, SHORT.label]) {
      if (isSettled(note, best!) || (best!.falls < through && best!.falls !== SHORT.clear)) break;
      search(through);
      if (best!.falls === SHORT.clear) break;
    }
    return best!;
  }
}

// How far inside the plot's border a card that lies inside it keeps, so it
// never reads as hung from the border.
const PLOT_INSET = 8;

// Neither wholly inside the plot (a clearance in from its border) nor
// wholly outside it (a gap away): across its border.
function straddles(rect: Rect, plot: Rect, gap: number): boolean {
  const inside =
    rect.left >= plot.left + PLOT_INSET && rect.right <= plot.right - PLOT_INSET && rect.top >= plot.top + PLOT_INSET && rect.bottom <= plot.bottom - PLOT_INSET;
  const outside = rect.right <= plot.left - gap || rect.left >= plot.right + gap || rect.bottom <= plot.top - gap || rect.top >= plot.bottom + gap;
  return !inside && !outside;
}

function polylineLength(line: Point[]): number {
  let length = 0;
  for (let index = 1; index < line.length; index += 1) length += Math.hypot(line[index].x - line[index - 1].x, line[index].y - line[index - 1].y);
  return length;
}

// The longest a bar's leader runs before its card reads as far from the bar.
function farRun(width: number): number {
  return Math.max(BAR_LEADER_FAR, width * 0.6);
}
const BAR_LEADER_FAR = 140;

/** The share of a note card cut from its top-right corner: along its top edge, and down its right side (the stylesheet's clip-path). */
export const NOTE_CARD_CUT = { top: 0.08, side: 0.23 } as const;

// A bar's leader: its last straight run onto the point at least this long,
// its run along at least this long, and the 45-degree corner it turns by.
const BAR_DROP = 14;
// How near a card past a bar's point sits to it: room for that last run.
const BAR_NEAR = BAR_DROP + 4;
const BAR_RUN = 12;
const BAR_JOG = 10;
// How many heights a run beside the card tries: the nearest to the point first.
const BAR_RUN_HEIGHTS = 4;
// How far a bar's leader keeps from the bars it passes.
const LEADER_CLEARANCE = 4;
// What coming onto a bar's point across its end, rather than from past
// it, costs, as pixels of leader.
const BAR_ACROSS = 60;

type MarksNear = (near: Rect, visit: (mark: Rect) => void) => void;

/** A leader to a bar, and whether it keeps clear of every other mark on its way. */
export interface BarRoute {
  path: Point[];
  clear: boolean;
}

export interface BarLeaderOptions {
  /** How far inside the card's edge the leader begins, so it grows out of the border. */
  overlap?: number;
  /** How close to one of the card's corners the leader may leave it. */
  inset?: number;
  /** The bar the point names: a leader never runs alongside it, short of its end. */
  bar?: Rect;
  /** The value the bar prints beside the point, which the leader lands by. */
  value?: Rect;
}

// How far from the side of the bar it names a leader keeps, short of the
// bar's end: closer, it reads as running along the bar.
const BAR_SIDE = 16;

// Each side of a point, turned into the frame where the leader comes from
// above: down onto the point.
function upright(from: Side) {
  const to = (p: Point): Point =>
    from === 'above' ? p : from === 'below' ? { x: p.x, y: -p.y } : from === 'left' ? { x: p.y, y: p.x } : { x: p.y, y: -p.x };
  const back = (p: Point): Point =>
    from === 'above' ? p : from === 'below' ? { x: p.x, y: -p.y } : from === 'left' ? { x: p.y, y: p.x } : { x: -p.y, y: p.x };
  const rect = (r: Rect): Rect => {
    const a = to({ x: r.left, y: r.top });
    const b = to({ x: r.right, y: r.bottom });
    return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
  };
  // Which of the card's own edges each turned edge is, and whether its run
  // is turned end for end.
  const edges: Record<'bottom' | 'left' | 'right', Side> =
    from === 'above' ? { bottom: 'below', left: 'left', right: 'right' }
      : from === 'below' ? { bottom: 'above', left: 'left', right: 'right' }
        : from === 'left' ? { bottom: 'right', left: 'above', right: 'below' }
          : { bottom: 'left', left: 'above', right: 'below' };
  const reversed = from === 'below' || from === 'right';
  return { to, back, rect, edges, reversed };
}

// The stretch of one of the card's edges a leader may leave it by: clear of
// its corners by `inset`, and of the corner its outline cuts.
function exitRange(card: Rect, edge: Side, inset: number): [number, number] {
  const width = card.right - card.left;
  const height = card.bottom - card.top;
  if (edge === 'above') return [card.left + inset, card.right - width * NOTE_CARD_CUT.top - inset];
  if (edge === 'below') return [card.left + inset, card.right - inset];
  if (edge === 'left') return [card.top + inset, card.bottom - inset];
  return [card.top + height * NOTE_CARD_CUT.side + inset, card.bottom - inset];
}

/**
 * The leader from a card to the bar it names, as the frames draw lines:
 * straight runs and 45-degree turns. It comes onto the point from `from`,
 * the side past the bar's end, so it never runs along or through the bar
 * it means: from a card past that end, out of the card's facing edge and
 * on to the point (as `routeLeader`); from a card beside it, out of the
 * card's side, along over the bars between, and a turn onto the point.
 * Of the routes that keep clear of every other mark, the shortest; where
 * none does, the shortest of them all, not clear.
 */
export function barLeader(card: Rect, point: Point, from: Side, marksNear: MarksNear, options: BarLeaderOptions = {}): BarRoute {
  const inset = options.inset ?? LEADER_INSET;
  const overlap = options.overlap ?? 0;
  // The bar's own printed value, beside the point, is what the leader
  // lands by, not in its way: that mark and no other (else whatever lies
  // that near the point).
  const value = options.value;
  const own = (mark: Rect) =>
    value
      ? Math.abs(mark.left - value.left) < 0.01 && Math.abs(mark.top - value.top) < 0.01 && Math.abs(mark.right - value.right) < 0.01 && Math.abs(mark.bottom - value.bottom) < 0.01
      : covers(mark, point, LEADER_CLEARANCE + 2);
  // The band along the named bar's sides, from its base to its end.
  const bar = options.bar;
  const alongside = bar
    ? from === 'above' || from === 'below'
      ? { ...bar, left: bar.left - BAR_SIDE, right: bar.right + BAR_SIDE }
      : { ...bar, top: bar.top - BAR_SIDE, bottom: bar.bottom + BAR_SIDE }
    : undefined;
  const clearOf = (path: Point[]) => {
    if (alongside && path.slice(1).some((b, index) => clipSegment(path[index], b, alongside))) return false;
    const line = shortOfEnd(path, LEADER_CLEARANCE + 2);
    for (let index = 1; index < line.length; index += 1) {
      const a = line[index - 1];
      const b = line[index];
      const span = inflate({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) }, LEADER_CLEARANCE);
      let hit = false;
      marksNear(span, (mark) => {
        if (!hit && !own(mark) && clipSegment(a, b, inflate(mark, LEADER_CLEARANCE))) hit = true;
      });
      if (hit) return false;
    }
    return true;
  };
  // Past the bar's end first; across the bar's end, from either side, at
  // a price; never from the bar's own side, which the bar itself blocks.
  const across: Side[] = from === 'above' || from === 'below' ? ['left', 'right'] : ['above', 'below'];
  const routes: Array<{ path: Point[]; length: number }> = [];
  for (const side of [from, ...across]) {
    const penalty = side === from ? 0 : BAR_ACROSS;
    for (const path of barRoutes(card, point, side, marksNear, inset, overlap)) {
      routes.push({ path, length: polylineLength(path) + penalty });
    }
  }
  if (routes.length === 0) return { path: routeLeader(card, point, { inset, overlap }), clear: false };
  // Shortest first, each checked only until one is clear: the check is
  // what costs, and a placement asks for the leader of every place it tries.
  routes.sort((a, b) => a.length - b.length);
  const clear = routes.find((route) => clearOf(route.path));
  return { path: (clear ?? routes[0]).path, clear: clear !== undefined };
}

// The routes onto the point from one side of it: from a card past the
// point on that side, out of its facing edge; from a card beside, out of
// its side, along, and a turn onto the point -- each worked out in the
// frame where that side is above.
function barRoutes(card: Rect, point: Point, from: Side, marksNear: MarksNear, inset: number, overlap: number): Point[][] {
  const turn = upright(from);
  const c = turn.rect(card);
  const q = turn.to(point);
  const along = (edge: Side): [number, number] => {
    const [lo, hi] = exitRange(card, edge, inset);
    return turn.reversed && edge !== turn.edges.bottom ? [-hi, -lo] : [lo, hi];
  };
  const routes: Point[][] = [];
  if (c.bottom <= q.y - BAR_DROP) {
    const [lo, hi] = along(turn.edges.bottom);
    if (hi >= lo) {
      const narrowed = { ...c, left: lo - inset, right: hi + inset };
      const path = routeLeader(narrowed, q, { inset, overlap });
      if (path.length > 1) routes.push(path.map(turn.back));
    }
  }
  for (const side of ['right', 'left'] as const) {
    const sideX = side === 'right' ? c.right : c.left;
    const direction = side === 'right' ? 1 : -1;
    if ((q.x - sideX) * direction < BAR_RUN) continue;
    const [lo, hi] = along(turn.edges[side]);
    const highest = Math.min(hi, q.y - BAR_DROP);
    if (highest < lo) continue;
    // The run as near the point as it can be, and just over each mark it
    // would cross there.
    const heights = [highest];
    const reach = { left: Math.min(sideX, q.x), right: Math.max(sideX, q.x), top: lo, bottom: highest };
    marksNear(turnBackRect(reach, turn.back), (mark) => {
      const y = turn.rect(mark).top - LEADER_CLEARANCE - 1;
      if (y >= lo && y < highest) heights.push(y);
    });
    // The nearest few, and always the highest: over the topmost of what lies
    // in the way, the one height a run along may clear it all at.
    const nearest = [...new Set(heights)].sort((a, b) => b - a);
    for (const y of new Set([...nearest.slice(0, BAR_RUN_HEIGHTS - 1), nearest[nearest.length - 1]])) {
      const jog = Math.max(0, Math.min(BAR_JOG, (q.y - y) / 2, Math.abs(q.x - sideX) / 2));
      const start = { x: sideX - direction * overlap, y };
      const path = jog >= 1 ? [start, { x: q.x - direction * jog, y }, { x: q.x, y: y + jog }, q] : [start, { x: q.x, y }, q];
      routes.push(path.map(turn.back));
    }
  }
  return routes;
}

// A rect given in the turned frame, back in the card's own.
function turnBackRect(rect: Rect, back: (p: Point) => Point): Rect {
  const a = back({ x: rect.left, y: rect.top });
  const b = back({ x: rect.right, y: rect.bottom });
  return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
}


export interface LeaderOptions {
  /** How close to one of the card's corners the leader may leave it. */
  inset?: number;
  /** The share of the card's width cut from its top-right corner. */
  cutTop?: number;
  /** How far inside the card's edge the leader begins, so it grows out of the border. */
  overlap?: number;
}

// The straight run out of the card before the leader turns, and how far
// across it steps on its 45-degree run where it has the room.
const LEADER_STUB = 12;
const LEADER_JOG = 26;

/**
 * The leader from a card to the point it names, as a polyline in the frames'
 * own geometry: out of the card's facing edge at right angles, one 45-degree
 * step across, and straight on to the point. Where the point is further
 * across than the leader has room to step, the step is preceded by a run
 * parallel to the edge, the way the frames' stepped corners are. Empty when
 * the card covers the point.
 */
export function routeLeader(card: Rect, point: Point, options: LeaderOptions = {}): Point[] {
  const inset = options.inset ?? LEADER_INSET;
  const cutTop = options.cutTop ?? 0;
  const overlap = options.overlap ?? 0;

  // Which edge faces the point, and the axes along it ("main", out of the
  // card) and across it.
  let edge: 'bottom' | 'top' | 'left' | 'right';
  if (point.y >= card.bottom) edge = 'bottom';
  else if (point.y <= card.top) edge = 'top';
  else if (point.x <= card.left) edge = 'left';
  else if (point.x >= card.right) edge = 'right';
  else return [];

  const vertical = edge === 'bottom' || edge === 'top';
  const main = edge === 'bottom' || edge === 'right' ? 1 : -1;
  const across = (p: Point) => (vertical ? p.x : p.y);
  const along = (p: Point) => (vertical ? p.y : p.x);
  const make = (a: number, m: number): Point => (vertical ? { x: a, y: m } : { x: m, y: a });

  const edgeAt = edge === 'bottom' ? card.bottom : edge === 'top' ? card.top : edge === 'left' ? card.left : card.right;
  const low = (vertical ? card.left : card.top) + inset;
  // The top edge stops short of the corner the card's outline cuts away (a
  // bar's leader is routed on the stretch `exitRange` leaves it instead).
  const high = (vertical ? card.right - (edge === 'top' ? (card.right - card.left) * cutTop : 0) : card.bottom) - inset;
  const reach = Math.abs(along(point) - edgeAt);
  const first = Math.min(LEADER_STUB, reach / 3);
  const last = Math.min(LEADER_STUB, reach / 4);
  const room = Math.max(0, reach - first - last);

  // Leave the card a step short of the point, on the side towards the
  // card's middle, so the leader always turns the way the frames do.
  const middle = vertical ? (card.left + card.right) / 2 : (card.top + card.bottom) / 2;
  const towardsMiddle = across(point) > middle ? -1 : 1;
  const exit = clamp(across(point) + towardsMiddle * Math.min(LEADER_JOG, room), low, Math.max(low, high));
  const start = make(exit, edgeAt - main * overlap);
  const offset = across(point) - exit;
  const direction = Math.sign(offset);
  const step = Math.abs(offset);

  if (step < 0.5 || reach < 1) return [start, point];
  const turn = edgeAt + main * first;
  if (step <= room) {
    // A step as long as the room for it can come out a rounding error
    // longer, a run along of 1e-14 that listed the same vertex twice.
    return withoutRepeats([start, make(exit, turn), make(across(point), turn + main * step), point]);
  }
  // Too far across to reach on the step alone: run along first.
  const run = step - room;
  return withoutRepeats([
    start,
    make(exit, turn),
    make(exit + direction * run, turn),
    make(across(point), turn + main * room),
    point,
  ]);
}
