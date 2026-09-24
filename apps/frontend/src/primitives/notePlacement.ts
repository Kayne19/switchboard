// Where the notes laid over a chart sit, and how each one's leader runs to
// the point it names. Pure geometry in one coordinate space (the note
// layer's CSS pixels), so the scene only measures and this decides.
//
// A note that names no point takes a corner; one that names a point centres
// over it. Either way a card sits in a row along the top or the bottom of
// the layer, and a later card takes the next row in, or the space beside an
// earlier one, rather than covering it. Among those places each card takes
// the one that hides the least: never its own point or another note's, then
// as little as it can of the traces and of the other notes' leaders, and
// never runs its own leader under another card; then the legend and axis
// labels, then the grid; and, for a note with a point, as close over it as
// that allows.

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
}

export interface NoteField {
  /** Where cards may sit: inside the panel's frame. */
  area: Rect;
  /** The plot's grid. */
  plot?: Rect;
  /** The drawn series, as the polylines the chart draws. */
  traces?: Point[][];
  /** Legend and axis labels: better left in view, but not at any cost. */
  labels?: Rect[];
}

/** Space kept between two cards, and between a card and the point it must not cover. */
export const NOTE_GAP = 10;

const COST = {
  ownPoint: 1e9,
  otherPoint: 1e8,
  cardOverlap: 1e7,
  cardOverlapArea: 100,
  traceLength: 40,
  leaderLength: 80,
  labelArea: 0.5,
  plotArea: 0.01,
  shift: 2.5,
  leader: 0.25,
  bottomRow: 60,
  rightCorner: 20,
};

const POINT_CLEARANCE = 6;

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function covers(rect: Rect, point: Point, clearance = POINT_CLEARANCE): boolean {
  return (
    point.x > rect.left - clearance &&
    point.x < rect.right + clearance &&
    point.y > rect.top - clearance &&
    point.y < rect.bottom + clearance
  );
}

// The length of the segment from `a` to `b` that falls inside `rect`
// (Liang-Barsky clipping).
function clippedLength(a: Point, b: Point, rect: Rect): number {
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
      if (q < 0) return 0;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return 0;
  }
  return Math.hypot(dx, dy) * (t1 - t0);
}

/** How much of the drawn traces a card at `rect` would hide, in pixels of line. */
export function hiddenTraceLength(rect: Rect, traces: Point[][]): number {
  let total = 0;
  for (const trace of traces) {
    for (let index = 1; index < trace.length; index += 1) {
      total += clippedLength(trace[index - 1], trace[index], rect);
    }
  }
  return total;
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

function unique(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]) > 0.5);
}

/**
 * Places each note's card in the field, in the order given except that the
 * notes naming no point go first: they settle into the corners, and the
 * notes naming a point then sit as near their points as the corners leave,
 * with leaders no card covers. Returns each card's box by note id.
 */
export function placeNotes(notes: NoteToPlace[], field: NoteField, gap = NOTE_GAP): Map<string, Rect> {
  const { area } = field;
  const traces = field.traces ?? [];
  const labels = field.labels ?? [];
  const order = [...notes.filter((note) => !note.point), ...notes.filter((note) => note.point)];
  const points = notes.flatMap((note) => (note.point ? [{ id: note.id, point: note.point }] : []));
  const placed = new Map<string, Rect>();
  const leaders: Point[][] = [];

  for (const note of order) {
    const { width, height, point } = note;
    const others = [...placed.values()];
    const minLeft = area.left;
    const maxLeft = area.right - width;
    const minTop = area.top;
    const maxTop = area.bottom - height;

    const lefts = unique(
      [
        ...(point ? [point.x - width / 2] : [minLeft, maxLeft]),
        ...[...others, ...labels].flatMap((other) => [other.left - gap - width, other.right + gap]),
      ].map((left) => clamp(left, minLeft, maxLeft)),
    );
    const tops = unique(
      [minTop, maxTop, ...[...others, ...labels].flatMap((other) => [other.bottom + gap, other.top - gap - height])].map((top) =>
        clamp(top, minTop, maxTop),
      ),
    );

    let best: { rect: Rect; cost: number } | undefined;
    for (const left of lefts) {
      for (const top of tops) {
        const rect = { left, top, right: left + width, bottom: top + height };
        let cost = 0;
        if (point && covers(rect, point)) cost += COST.ownPoint;
        for (const other of points) {
          if (other.id !== note.id && covers(rect, other.point)) cost += COST.otherPoint;
        }
        for (const other of others) {
          const area = overlapArea(rect, other);
          if (area > 0) cost += COST.cardOverlap + area * COST.cardOverlapArea;
        }
        cost += hiddenTraceLength(rect, traces) * COST.traceLength;
        cost += hiddenTraceLength(rect, leaders) * COST.leaderLength;
        if (point) {
          const leader = routeLeader(rect, point);
          for (const other of others) cost += hiddenTraceLength(other, [leader]) * COST.leaderLength;
        }
        for (const label of labels) cost += overlapArea(rect, label) * COST.labelArea;
        if (field.plot) cost += overlapArea(rect, field.plot) * COST.plotArea;
        const nearTop = top - minTop <= maxTop - top;
        if (point) {
          cost += Math.abs(left + width / 2 - point.x) * COST.shift;
          const leaderLength = point.y >= rect.bottom ? point.y - rect.bottom : point.y <= rect.top ? rect.top - point.y : 0;
          cost += leaderLength * COST.leader;
        } else if (left - minLeft > maxLeft - left) {
          cost += COST.rightCorner;
        }
        if (!nearTop) cost += COST.bottomRow;
        if (!best || cost < best.cost - 1e-6) best = { rect, cost };
      }
    }
    placed.set(note.id, best!.rect);
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
  const inset = options.inset ?? 16;
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
