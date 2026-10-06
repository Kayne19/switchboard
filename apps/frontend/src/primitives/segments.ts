// Straight segments against rects and against each other, in one plane:
// the maths the notes laid over a chart place their cards and leaders by
// (notePlacement) and draw their leaders with (ChartNotes).

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

// The share of the segment from `a` to `b` that falls inside `rect`, as the
// parameters it enters and leaves at (Liang-Barsky clipping), or undefined
// when it misses the rect.
export function clipSegment(a: Point, b: Point, rect: Rect): [number, number] | undefined {
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

// Whether the segments a-b and c-d cross or touch.
export function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
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

/** The polyline without a vertex that repeats the one before it (within a millionth of a pixel). */
export function withoutRepeats(line: Point[]): Point[] {
  return line.filter((point, index) => index === 0 || Math.hypot(point.x - line[index - 1].x, point.y - line[index - 1].y) > 1e-6);
}

/**
 * The polyline as a crisp one-pixel line draws it: each vertex on the half
 * pixel, and none repeating the one before, which a run or a step shorter
 * than a pixel would leave there once both its ends are snapped.
 */
export function crispLine(line: Point[]): Point[] {
  const snap = (value: number) => Math.round(value - 0.5) + 0.5;
  return withoutRepeats(line.map((point) => ({ x: snap(point.x), y: snap(point.y) })));
}
