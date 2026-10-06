import type { DiagramObjectData, NoteData } from '../controller/types';
import { DiagramPrimitive } from '../primitives/DiagramPrimitive';
import { SequencePrimitive } from '../primitives/SequencePrimitive';
import type { Slot } from '../primitives/slot';

// A diagram object is drawn by the primitive for its mode. The graph
// primitive alone places an anchored note as a callout; a sequence keeps
// the note in the rail and only marks the actor it names.
export function DiagramObject({
  data,
  id,
  slot,
  note,
  onCalloutChange,
}: {
  data: DiagramObjectData;
  /** The object's id: an anchored note belongs to it only when `anchor.target` matches. */
  id: string;
  slot?: Slot;
  note?: NoteData | null;
  onCalloutChange?: (placed: boolean) => void;
}) {
  if (data.mode === 'sequence') {
    return <SequencePrimitive data={data} id={id} slot={slot} note={note} />;
  }
  return <DiagramPrimitive data={data} id={id} slot={slot} note={note} onCalloutChange={onCalloutChange} />;
}
