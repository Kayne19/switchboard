// The geometry the layout tests check a drawing with, written once:
// diagramLayout.test.ts and diagramLayoutFuzz.test.ts each kept a copy, and
// sequenceLayout.test.ts its own `overlaps`. A box is x, y, width, height,
// as the layouts' Box (primitives/geometry.ts) is.
import { ARROW_LENGTH } from '../../src/primitives/diagramLayout';
import type { Box, Point } from '../../src/primitives/geometry';

export const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export const inset = (box: Box, by: number): Box => ({
  x: box.x + by,
  y: box.y + by,
  width: box.width - 2 * by,
  height: box.height - 2 * by,
});

export const within = (box: Box, width: number, height: number) =>
  box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;

// Every route is axis-aligned, so a segment is a zero-thickness box.
export const segmentBox = (a: Point, b: Point): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(Math.abs(a.x - b.x), 0.001),
  height: Math.max(Math.abs(a.y - b.y), 0.001),
});

// A label names the route it sits on: its centre lies on one of the
// route's segments.
export const onRoute = (point: Point, points: Point[]) =>
  points.slice(1).some((end, index) => {
    const box = segmentBox(points[index], end);
    return point.x >= box.x - 1e-6 && point.x <= box.x + box.width + 1e-6 && point.y >= box.y - 1e-6 && point.y <= box.y + box.height + 1e-6;
  });

// The arrowhead at a route's end: the last ARROW_LENGTH of its final
// segment, as wide as it is long.
export const arrowhead = (points: Point[]): Box => {
  const end = points[points.length - 1];
  const before = points[points.length - 2];
  if (Math.abs(end.y - before.y) < 1e-6) {
    const back = end.x - Math.sign(end.x - before.x) * ARROW_LENGTH;
    return { x: Math.min(end.x, back), y: end.y - ARROW_LENGTH / 2, width: ARROW_LENGTH, height: ARROW_LENGTH };
  }
  const back = end.y - Math.sign(end.y - before.y) * ARROW_LENGTH;
  return { x: end.x - ARROW_LENGTH / 2, y: Math.min(end.y, back), width: ARROW_LENGTH, height: ARROW_LENGTH };
};
