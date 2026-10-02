// Pure geometry for the route overlay: wires between anchor rectangles.

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const leftMid = (box: Box, dy = 0): Point => ({ x: box.x, y: box.y + box.h / 2 + dy });
export const rightMid = (box: Box, dy = 0): Point => ({ x: box.x + box.w, y: box.y + box.h / 2 + dy });

/** Keep a point inside a scroll viewport; report whether it was moved. */
export function clampToClip(point: Point, clip: Box | undefined, inset = 10): { point: Point; clipped: boolean } {
  if (!clip) return { point, clipped: false };
  const top = clip.y + inset;
  const bottom = clip.y + clip.h - inset;
  const y = Math.min(bottom, Math.max(top, point.y));
  return { point: { x: point.x, y }, clipped: y !== point.y };
}

/** A horizontal S-curve from `a` to `b`, either direction. */
export function wire(a: Point, b: Point): string {
  const span = Math.abs(b.x - a.x);
  const dx = Math.max(24, span / 2) * (b.x >= a.x ? 1 : -1);
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${(a.x + dx).toFixed(1)},${a.y.toFixed(1)} ${(b.x - dx).toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

/** The point halfway along `wire(a, b)`, for its label. */
export function wireMid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** One continuous path through every point, wiring each consecutive pair. */
export function chain(points: Point[]): string {
  if (points.length < 2) return '';
  let path = wire(points[0], points[1]);
  for (let index = 1; index < points.length - 1; index += 1)
    path += ' ' + wire(points[index], points[index + 1]).replace(/^M[^C]+/, 'L' + points[index].x.toFixed(1) + ',' + points[index].y.toFixed(1) + ' ');
  return path;
}
