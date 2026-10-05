// Straight segments against rects and against each other, in one plane:
// the maths the chart and the notes laid over it share. The chart prints a
// point's value where the lines leave room for a leader (chartGeometry);
// the notes keep their cards and leaders off those lines (notePlacement).
// Neither depends on the other: both read this.

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

// How near the segments a-b and c-d come to each other: 0 where they meet.
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsMeet(a, b, c, d)) return 0;
  const toSegment = (p: Point, q: Point, r: Point) => {
    const dx = r.x - q.x;
    const dy = r.y - q.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.min(1, Math.max(0, ((p.x - q.x) * dx + (p.y - q.y) * dy) / length)) : 0;
    return Math.hypot(p.x - (q.x + dx * t), p.y - (q.y + dy * t));
  };
  return Math.min(toSegment(a, c, d), toSegment(b, c, d), toSegment(c, a, b), toSegment(d, a, b));
}
