// The drawing kit: what a graph (DiagramPrimitive + diagramLayout) and a
// sequence (SequencePrimitive + sequenceLayout) draw alike, said once. Each
// drawing keeps its own sizes (its frames' cuts, its arrowheads).

import { textCells } from '../design/textCells';
import { monoAdvance } from '../design/tokens';
import type { Point, Size } from './geometry';

/** An SVG path through `points`, straight from each to the next. */
export const pathThrough = (points: readonly Point[]) =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

/** A frame's outline, `width` by `height` (a node, an actor's header): its top corners cut across, its bottom left stepped. */
export function steppedFrame(width: number, height: number, { topLeft, topRight, bottomLeft }: { topLeft: number; topRight: number; bottomLeft: number }): string {
  return `M 0 ${topLeft} L ${topLeft} 0 H ${width - topRight} L ${width} ${topRight} V ${height} H ${bottomLeft} L 0 ${height - bottomLeft} Z`;
}

// A label on a line (.diagram-edge-label, .sequence-message-label) is set in
// the monospace face at 11 units with 0.06em tracking, so it is measured
// before it is drawn (monoAdvance, rounded up: 7.3); its lines LABEL_HEIGHT
// apart, on a backing LABEL_BACKING past them each side.
export const LABEL_ADVANCE = monoAdvance(11, 0.06, { roundUp: true });
export const LABEL_HEIGHT = 14;
export const LABEL_BACKING = 4;

/** The backing a label drawn on `lines` paints over. */
export function labelBox(lines: readonly string[]): Size {
  return {
    width: Math.max(...lines.map(textCells)) * LABEL_ADVANCE + 2 * LABEL_BACKING,
    height: lines.length * LABEL_HEIGHT + 2 * LABEL_BACKING,
  };
}

/** A drawing is composed in portrait once its viewport is a little taller than wide. */
export function drawingOrientation(viewport: Size): 'landscape' | 'portrait' {
  return viewport.height > viewport.width * 1.05 ? 'portrait' : 'landscape';
}

/** The glows a drawing's lit parts carry, by id: a lit `line` (an edge, a message) and a lit `frame` (a node, a header). */
export function GlowFilters({ line, frame }: { line: string; frame: string }) {
  return (
    <>
      {/* The region is the whole drawing, not each line's bounding box: a
          straight line has a zero-height box, and a filter region derived
          from it would erase the line entirely. */}
      <filter id={line} filterUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
        <feGaussianBlur stdDeviation="2.2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      {/* A lit frame is drawn inside its node's or header's translated
          group, where the drawing-wide region above would begin at the
          frame's own corner and cut the glow, and half the stroke, off its
          top and left edges. A frame has a real box, so this region is that
          box with room on every side. */}
      <filter id={frame} x="-25%" y="-50%" width="150%" height="200%">
        <feGaussianBlur stdDeviation="2.2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </>
  );
}
