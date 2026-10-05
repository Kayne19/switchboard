// The NOTE marker: the badge a rail note carries when it names a part of
// a drawing (AnnotationCard's `.annotation-card__node-badge`), drawn on
// that part, so the reader can match the two: a graph's node, in its
// corner (diagramLayout `cornerTagBoxes`); a sequence's actor, in its
// header (sequenceLayout `markerIn`). Its text is 9 user units, the size a
// drawing's readable minimum holds at the page's micro floor.

/** The marker's size in user units: the one both layouts make room for. */
export const NOTE_MARKER = { width: 30, height: 15 } as const;

export interface MarkerBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function NoteMarker({ box, className }: { box: MarkerBox; className: string }) {
  return (
    <g className={className} transform={`translate(${box.x}, ${box.y})`}>
      <rect width={box.width} height={box.height} rx="2" fill="rgba(var(--orange-rgb), 0.25)" stroke="var(--orange)" strokeWidth="1" />
      <text
        x={box.width / 2}
        y={box.height / 2 + 3.5}
        textAnchor="middle"
        fill="var(--orange)"
        fontSize="9"
        fontWeight="700"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
        letterSpacing="0.05em"
      >
        NOTE
      </text>
    </g>
  );
}
