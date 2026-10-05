import { AnimatePresence, motion } from 'motion/react';
import type { MouseEvent } from 'react';
import type {
  ChartData,
  CodeData,
  DiagramObjectData,
  DocumentData,
  ImageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
  TableData,
  TimerData,
} from '../controller/types';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { CodeViewport } from '../primitives/CodeViewport';
import { DiagramObject } from './DiagramObject';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { ImagePrimitive } from '../primitives/ImagePrimitive';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { TablePrimitive } from '../primitives/TablePrimitive';
import { TemporaryAssistantList } from '../primitives/TemporaryAssistantList';
import { TimerPrimitive } from '../primitives/TimerPrimitive';
import { SurfaceBoundary } from './SurfaceBoundary';

// `marked` is the item a note names in the object (`anchoredItem`), which
// the object marks in focus as it does in the scene.
function FocusedObject({ object, marked }: { object: SceneObject; marked?: string }) {
  switch (object.type) {
    case 'chart':
      return <ChartPrimitive data={object.data as ChartData} focused />;
    case 'diagram':
      return <DiagramObject data={object.data as DiagramObjectData} id={object.id} focused />;
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
    case 'timer':
      return <TimerPrimitive data={object.data as TimerData} marked={marked} focused />;
    // TEMPORARY (pa-contract): replaced by the render slice, a primitive per type.
    case 'calendar':
    case 'tasks':
    case 'weather':
    case 'inbox':
      return <TemporaryAssistantList type={object.type} data={object.data} marked={marked} />;
    default:
      return null;
  }
}

export function FocusLayer({ object, marked, onClose }: { object: SceneObject | null; marked?: string; onClose: () => void }) {
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
            className={`focus-layer__content focus-layer__content--${object.type}`}
            layoutId={`switchboard-object-${object.id}`}
            transition={{ layout: { duration: 0.46, ease: [0.22, 0.61, 0.36, 1] } }}
          >
            <div className="focus-layer__header tech micro">
              <span>FOCUS / {object.type.toUpperCase()}</span>
              <button type="button" onClick={onClose}>RETURN / ESC</button>
            </div>
            <SurfaceBoundary surfaceId={object.id} resetKey={object}>
              <FocusedObject object={object} marked={marked} />
            </SurfaceBoundary>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
