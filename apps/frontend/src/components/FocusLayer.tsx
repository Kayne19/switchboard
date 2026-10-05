import { AnimatePresence, motion } from 'motion/react';
import type { MouseEvent } from 'react';
import type {
  ChartData,
  CodeData,
  ControllerState,
  DiagramObjectData,
  DocumentData,
  ImageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
  TableData,
} from '../controller/types';
import { objectsOfType } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { CodeViewport } from '../primitives/CodeViewport';
import { DiagramObject } from './DiagramObject';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { ImagePrimitive } from '../primitives/ImagePrimitive';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { TablePrimitive } from '../primitives/TablePrimitive';
import { SurfaceBoundary } from './SurfaceBoundary';

/**
 * The note focus keeps beside a diagram: the first note on stage anchored
 * to it, as the scene's rail shows it. Focus gives the diagram the stage
 * and the rail goes, so the note comes with the diagram: in a panel of its
 * own beside or under it, and the node or actor it names keeps its NOTE
 * marker, the drawing opening on it.
 */
export function focusNote(state: ControllerState, object: SceneObject | null): NoteData | null {
  if (object?.type !== 'diagram') return null;
  return objectsOfType<NoteData>(state, 'note').find((note) => note.data.anchor?.target === object.id)?.data ?? null;
}

function FocusedObject({ object, note }: { object: SceneObject; note: NoteData | null }) {
  switch (object.type) {
    case 'chart':
      return <ChartPrimitive data={object.data as ChartData} focused />;
    case 'diagram':
      // The note stands in its own panel here, never as a callout on the drawing.
      return <DiagramObject data={object.data as DiagramObjectData} id={object.id} focused note={note} callout={false} />;
    case 'document':
      return <DocumentViewport data={object.data as DocumentData} focused />;
    case 'code':
      return <CodeViewport data={object.data as CodeData} focused />;
    case 'table':
      return <TablePrimitive data={object.data as TableData} focused />;
    case 'image':
      return <ImagePrimitive data={object.data as ImageData} focused />;
    case 'note':
      return <AnnotationCard data={object.data as NoteData} />;
    case 'metric':
      return <MetricsPrimitive metrics={[object as SceneObject<MetricData>]} />;
    case 'progress':
      return <ProgressPrimitive data={object.data as ProgressData} />;
    default:
      return null;
  }
}

// Where the note stands is the focus box's geometry, in the stylesheet
// (`.focus-layer__content--noted`): beside a wide drawing, as the rail is,
// and under a tall one.
export function FocusLayer({ object, note = null, onClose }: { object: SceneObject | null; note?: NoteData | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {object ? (
        <motion.div
          className="focus-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          role="dialog"
          aria-modal="true"
          aria-label={`Focused ${object.type}`}
          onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            className={`focus-layer__content focus-layer__content--${object.type}${note ? ' focus-layer__content--noted' : ''}`}
            layoutId={`switchboard-object-${object.id}`}
            transition={{ layout: { duration: 0.46, ease: [0.22, 0.61, 0.36, 1] } }}
          >
            <div className="focus-layer__header tech micro">
              <span>FOCUS / {object.type.toUpperCase()}</span>
              <button type="button" onClick={onClose}>RETURN / ESC</button>
            </div>
            <SurfaceBoundary surfaceId={object.id} resetKey={object}>
              <FocusedObject object={object} note={note} />
            </SurfaceBoundary>
            {note ? (
              <aside className="focus-layer__note">
                <SurfaceBoundary surfaceId="focus-note" resetKey={note}>
                  <AnnotationCard data={note} />
                </SurfaceBoundary>
              </aside>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
