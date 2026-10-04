import type { DiagramObjectData, NoteData } from '../controller/types';
import { DiagramPrimitive } from '../primitives/DiagramPrimitive';
import { SequencePrimitive } from '../primitives/SequencePrimitive';

// A diagram object is drawn by the primitive for its mode. The graph
// primitive alone places an anchored note as a callout; a sequence keeps
// the note in the rail and only marks the actor it names.
export function DiagramObject({
  data,
  id,
  focused,
  note,
  onCalloutChange,
}: {
  data: DiagramObjectData;
  /** The object's id: an anchored note belongs to it only when `anchor.target` matches. */
  id: string;
  focused?: boolean;
  note?: NoteData | null;
  onCalloutChange?: (placed: boolean) => void;
}) {
  if (data.mode === 'sequence') {
    return <SequencePrimitive data={data} id={id} focused={focused} note={note} />;
  }
  return <DiagramPrimitive data={data} id={id} focused={focused} note={note} onCalloutChange={onCalloutChange} />;
}
