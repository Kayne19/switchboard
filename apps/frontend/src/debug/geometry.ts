// Pure geometry for the route overlay: lines between anchor rectangles.

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

const fixed = (value: number) => value.toFixed(1);

/**
 * An orthogonal line from `a` to `b`, either direction: across, then along
 * the vertical halfway between them, then across again. The main page's
 * diagram edges route the same way.
 */
export function wire(a: Point, b: Point): string {
  if (Math.abs(a.y - b.y) < 0.5) return `M${fixed(a.x)},${fixed(a.y)} H${fixed(b.x)}`;
  const middle = (a.x + b.x) / 2;
  return `M${fixed(a.x)},${fixed(a.y)} H${fixed(middle)} V${fixed(b.y)} H${fixed(b.x)}`;
}

/** The point halfway along `wire(a, b)`, for its label. */
export function wireMid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
