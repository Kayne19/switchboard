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
// fills and labels at most, never over the data. A chart whose data leaves
// a card no place near its point (every bar standing to the top, and no
// band above it as tall as the card) has that card astray: given `spill`,
// one note is left out for the scene to show elsewhere (the rail) -- the
// one whose absence leaves the fewest cards astray, sooner a note naming no
// point -- and the others are placed without it; without, each card takes
// the place that hides the least.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

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
  /** What the chart draws as areas, as drawn: each bar, each scatter point, the marker ring. */
  marks?: Rect[];
  /** An area chart's fill under its line, as convex pieces: softer than the rest of the data. */
  fills?: Point[][];
  /** Legend and axis labels: kept clear like the data, but given up before it. */
  labels?: Rect[];
}

/** Space kept between two cards, and between a card and the point it must not cover. */
export const NOTE_GAP = 10;

/** Space kept between a card and the data the chart draws, so a card never reads as resting on a bar. */
export const DATA_CLEARANCE = 6;

const COST = {
  ownPoint: 1e9,
  otherPoint: 1e8,
  cardOverlap: 1e7,
  skirtingPoint: 2e6,
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
// From this many marks or line segments on, they are bucketed by where they lie.
const BUCKETED_FROM = 256;
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
// should run, the data under it, and last everything that was always ruled
// out (its point, another's, another card, level with its point).
const SHORT = { clear: 0, fill: 1, label: 2, far: 3, data: 4, more: 5 } as const;

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

// The share of the segment from `a` to `b` that falls inside `rect`, as the
// parameters it enters and leaves at (Liang-Barsky clipping), or undefined
// when it misses the rect.
function clipSegment(a: Point, b: Point, rect: Rect): [number, number] | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - rect.left],
    [dx, rect.right - a.x],
    [-dy, a.y - rect.top],
    [dy, rect.bottom - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return undefined;
  }
  return [t0, t1];
}

/** How much of the drawn traces a card at `rect` would hide, in pixels of line. */
export function hiddenTraceLength(rect: Rect, traces: Point[][]): number {
  let total = 0;
  for (const trace of traces) {
    for (let index = 1; index < trace.length; index += 1) {
      const a = trace[index - 1];
      const b = trace[index];
      const share = clipSegment(a, b, rect);
      if (share) total += Math.hypot(b.x - a.x, b.y - a.y) * (share[1] - share[0]);
    }
  }
  return total;
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

// Whether the segments a-b and c-d cross or touch.
function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const within = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
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

/** Options for `placeNotes`. */
export interface PlaceOptions {
  /** Space kept between two cards, and between a card and the point it must not cover. */
  gap?: number;
  /**
   * The scene can show one note elsewhere (the rail). Where some card has
   * no place clear of the data within reach of its point, one note is then
   * left out, its card not placed: the one whose absence leaves the fewest
   * cards astray, sooner a note naming no point (which may itself have had
   * a clear place), and only if that leaves fewer astray. Its point still
   * stands in the other cards' way.
   */
  spill?: boolean;
}

interface Placement {
  rect: Rect;
  cost: number;
  /** The worst of `SHORT` the place falls short by. */
  falls: number;
  /** Over the data, or too far along from its point for its leader to read as its own. */
  astray: boolean;
}

/**
 * Places each note's card in the field, in the order given except that the
 * notes naming no point go first: they settle into the corners, and the
 * notes naming a point then sit as near their points as the corners leave,
 * with leaders no card covers. Returns each card's box by note id; with
 * `spill`, the one note it leaves out has none.
 */
export function placeNotes(notes: NoteToPlace[], field: NoteField, options: PlaceOptions = {}): Map<string, Rect> {
  const gap = options.gap ?? NOTE_GAP;
  const prepared = prepare(field);
  const all = placeInOrder(notes, prepared, gap);
  const over = (placements: Map<string, Placement>) => [...placements.values()].filter((placement) => placement.astray).length;
  let chosen = all;
  if (options.spill && over(all) > 0) {
    // Leave out the note whose absence leaves the fewest cards astray:
    // sooner one that names no point, which loses nothing in the rail; then
    // one that was astray itself; then the cheapest.
    const better = (a: number[], b: number[]) => {
      const index = a.findIndex((value, at) => Math.abs(value - b[at]) > 1e-6);
      return index >= 0 && a[index] < b[index];
    };
    let best: { placements: Map<string, Placement>; rank: number[] } | undefined;
    for (const note of notes) {
      const placements = placeInOrder(notes, prepared, gap, note.id, all);
      const rank = [
        over(placements),
        note.point ? 1 : 0,
        all.get(note.id)!.astray ? 0 : 1,
        [...placements.values()].reduce((sum, placement) => sum + placement.cost, 0),
      ];
      if (rank[0] >= over(all)) continue;
      if (!best || better(rank, best.rank)) best = { placements, rank };
    }
    if (best) chosen = best.placements;
  }
  return new Map([...chosen].map(([id, placement]) => [id, placement.rect]));
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
function bucketed<T>(items: T[], boxOf: (item: T) => Rect, area: Rect): (near: Rect, visit: (item: T) => void) => void {
  // A few are read faster one after another than through the buckets.
  if (items.length <= BUCKETED_FROM) return (_near, visit) => items.forEach((item) => visit(item));
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
  marks: Rect[];
  fills: Point[][];
  labels: Rect[];
  segmentsNear: (near: Rect, visit: (segment: [Point, Point]) => void) => void;
  marksNear: (near: Rect, visit: (mark: Rect) => void) => void;
}

function prepare(field: NoteField): Prepared {
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
    marks,
    fills: field.fills ?? [],
    labels: field.labels ?? [],
    segmentsNear: bucketed(segments, ([a, b]) => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) }), area),
    marksNear: bucketed(marks, (mark) => mark, area),
  };
}

// Places the notes one by one, all of them but `leftOut`. Those placed
// before `leftOut` would take the same places as in `before`, the run with
// every note, so they are taken from it.
function placeInOrder(
  notes: NoteToPlace[],
  field: Prepared,
  gap: number,
  leftOut?: string,
  before?: Map<string, Placement>,
): Map<string, Placement> {
  const { area, plot, marks, fills, labels, segmentsNear, marksNear } = field;
  const everyNote = [...notes.filter((note) => !note.point), ...notes.filter((note) => note.point)];
  const order = everyNote.filter((note) => note.id !== leftOut);
  const settled = before ? everyNote.slice(0, Math.max(0, everyNote.findIndex((note) => note.id === leftOut))) : [];
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
    const { width, height, point } = note;
    const earlier = settled.includes(note) ? before?.get(note.id) : undefined;
    if (earlier) {
      placed.set(note.id, earlier);
      if (point) leaders.push(routeLeader(earlier.rect, point));
      continue;
    }
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
    const consider = (left: number, top: number) => {
      const rect = { left, top, right: left + width, bottom: top + height };
      let cost = 0;
      let falls: number = SHORT.clear;
      if (point && covers(rect, point)) cost += COST.ownPoint;
      else if (point) {
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
      if (cost > 0) falls = SHORT.more;
      // Places rank by what they fall short by, then by cost. Neither ever
      // falls as more is added up, so a place already behind the best so
      // far cannot win.
      const beaten = () => best !== undefined && (falls > best.falls || (falls === best.falls && cost >= best.cost - 1e-6));
      // Its point further along than the leader should run beside the card.
      const along = point ? Math.max(0, left + LEADER_INSET - point.x, point.x - (left + width - LEADER_INSET)) - width * SEARCH_REACH : 0;
      if (along > 0) {
        cost += COST.far + along * COST.farAlong;
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
      if (point) {
        const leader = routeLeader(rect, point);
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
      if (plot) cost += overlapArea(rect, plot) * COST.plotArea;
      const nearTop = top - minTop <= maxTop - top;
      if (point) {
        cost += Math.abs(left + width / 2 - point.x) * COST.shift;
        const leaderLength = point.y >= rect.bottom ? point.y - rect.bottom : point.y <= rect.top ? rect.top - point.y : 0;
        cost += leaderLength * COST.leader;
        // Nearer than a gap, a leader's first turn hugs the border it leaves.
        if (leaderLength > 0) cost += Math.max(0, gap - leaderLength) * COST.hug;
      } else if (left - minLeft > maxLeft - left) {
        cost += COST.rightCorner;
      }
      if (!nearTop) cost += COST.bottomRow;
      if (!best || falls < best.falls || (falls === best.falls && cost < best.cost - 1e-6)) best = { rect, cost, falls, astray: data || along > 0 };
    };

    // Every place a card spanning `left` can sit clear of what stands in
    // its way there -- its point's band, the other points and cards, the
    // data a clearance away, and the labels and the fills unless `through`
    // lets the card over them -- with the lefts it tries within reach of
    // its point, so its leader never runs far along to it.
    const search = (through: number) => {
      const blocks = (rect: Rect, left: number, right: number) => rect.left < right && rect.right > left;
      const reach = width * SEARCH_REACH;
      const low = point ? Math.max(minLeft, point.x - width + LEADER_INSET - reach) : minLeft;
      const high = point ? Math.min(maxLeft, point.x - LEADER_INSET + reach) : maxLeft;
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
      ];
      for (const left of unique(candidates.filter((left) => left >= low && left <= high))) {
        const right = left + width;
        const blocked: Array<[number, number]> = [];
        // Its own point's band: a place clear of the point's height by the
        // clearance `standing` asks for, so its leader leaves by the top or
        // bottom border.
        if (point) blocked.push([point.y - POINT_CLEARANCE, point.y + POINT_CLEARANCE]);
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
        let from = minTop;
        const runs: Array<[number, number]> = [];
        for (const [start, end] of blocked) {
          if (start > from) runs.push([from, Math.min(start, area.bottom)]);
          from = Math.max(from, end);
        }
        if (area.bottom > from) runs.push([from, area.bottom]);
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
          ];
          for (const top of unique(turns.filter((top) => top >= first && top <= last))) consider(left, top);
        }
      }
    };

    for (const left of lefts) {
      for (const top of tops) consider(left, top);
    }
    if (point && best!.falls === SHORT.more) {
      // No row clears the point: straight above or below it, a gap away,
      // and last beside it, level with it.
      for (const top of unique([point.y - gap - height, point.y + gap].map(clampTop))) {
        for (const left of lefts) consider(left, top);
      }
      const besideTop = clampTop(point.y - height / 2);
      for (const left of unique([point.x - BESIDE_POINT - width, point.x + BESIDE_POINT].map(clampLeft))) consider(left, besideTop);
    }
    // None of those is clear: anywhere within reach clear of everything,
    // then over a fill at most, then over fills and labels at most, never
    // over the data. A place
    // that falls short only as far as a search lets one still has the
    // search look for a nearer one.
    for (const through of [SHORT.clear, SHORT.fill, SHORT.label]) {
      if (best!.falls === SHORT.clear || best!.falls < through) break;
      search(through);
    }
    placed.set(note.id, best!);
    if (point) leaders.push(routeLeader(best!.rect, point));
  }
  return placed;
}

export interface LeaderOptions {
  /** The straight run out of the card before the leader turns. */
  stub?: number;
  /** How far across the leader steps on its 45-degree run, where it has the room. */
  jog?: number;
  /** How close to one of the card's corners the leader may leave it. */
  inset?: number;
  /** The share of the card's width cut from its top-right corner. */
  cutTop?: number;
  /** How far inside the card's edge the leader begins, so it grows out of the border. */
  overlap?: number;
}

/**
 * The leader from a card to the point it names, as a polyline in the frames'
 * own geometry: out of the card's facing edge at right angles, one 45-degree
 * step across, and straight on to the point. Where the point is further
 * across than the leader has room to step, the step is preceded by a run
 * parallel to the edge, the way the frames' stepped corners are. Empty when
 * the card covers the point.
 */
export function routeLeader(card: Rect, point: Point, options: LeaderOptions = {}): Point[] {
  const stub = options.stub ?? 12;
  const jog = options.jog ?? 26;
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
  // The top edge stops short of the corner the card's outline cuts away.
  const high = (vertical ? card.right - (edge === 'top' ? (card.right - card.left) * cutTop : 0) : card.bottom) - inset;
  const reach = Math.abs(along(point) - edgeAt);
  const first = Math.min(stub, reach / 3);
  const last = Math.min(stub, reach / 4);
  const room = Math.max(0, reach - first - last);

  // Leave the card a step short of the point, on the side towards the
  // card's middle, so the leader always turns the way the frames do.
  const middle = vertical ? (card.left + card.right) / 2 : (card.top + card.bottom) / 2;
  const towardsMiddle = across(point) > middle ? -1 : 1;
  const exit = clamp(across(point) + towardsMiddle * Math.min(jog, room), low, Math.max(low, high));
  const start = make(exit, edgeAt - main * overlap);
  const offset = across(point) - exit;
  const direction = Math.sign(offset);
  const step = Math.abs(offset);

  if (step < 0.5 || reach < 1) return [start, point];
  const turn = edgeAt + main * first;
  if (step <= room) {
    return [start, make(exit, turn), make(across(point), turn + main * step), point];
  }
  // Too far across to reach on the step alone: run along first.
  const run = step - room;
  return [
    start,
    make(exit, turn),
    make(exit + direction * run, turn),
    make(across(point), turn + main * room),
    point,
  ];
}
