// The NOTE marker: the badge a rail note carries when it names a part of
// what it is about (AnnotationCard, `NoteBadge`), drawn on that part, so
// the reader can match the two: a graph's node, in its corner
// (diagramLayout `cornerTagBoxes`); a sequence's actor, in its header
// (sequenceLayout `markerIn`); an item of a list (`note.anchor.item`: a task,
// a message, an event, a timer, a forecast hour or day), beside it. In a
// drawing it is SVG (`NoteMarker`), its text 9 user units, the size a
// drawing's readable minimum holds at the page's micro floor; on the card
// and in a list it is the same badge in HTML (`NoteBadge`).

import type { NoteData } from '../controller/types';
import type { Box } from './geometry';

/** The part of the object `objectId` the drawn note `note` names, which the
 * object marks: a list's `item`, a graph's or a sequence's `node`; nothing
 * for a note about another object, even one that names a part of this one. */
export function markedPart(note: NoteData | null | undefined, objectId: string): { item?: string; node?: string } {
  const anchor = note?.anchor;
  return anchor?.target === objectId ? { item: anchor.item, node: anchor.node } : {};
}

/** The marker's size in user units: the one both layouts make room for. */
export const NOTE_MARKER = { width: 30, height: 15 } as const;

export function NoteMarker({ box, className }: { box: Box; className: string }) {
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

/** The NOTE badge in HTML: on the rail card that names a part, and on the
 * item of a list the note names. */
export function NoteBadge({ className }: { className?: string }) {
  return <span className={`note-badge tech micro${className ? ` ${className}` : ''}`}>NOTE</span>;
}
