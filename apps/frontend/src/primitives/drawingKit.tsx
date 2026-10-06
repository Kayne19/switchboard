// The drawing kit: what a graph (DiagramPrimitive + diagramLayout) and a
// sequence (SequencePrimitive + sequenceLayout) draw alike, said once so the
// two read as one instrument. Each drawing keeps its own sizes; the kit
// holds the rules they share.

/** An SVG path through `points`, straight from each to the next. */
export const pathThrough = (points: ReadonlyArray<{ x: number; y: number }>) =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

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
