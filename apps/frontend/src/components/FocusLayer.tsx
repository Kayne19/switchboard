import { AnimatePresence, motion } from 'motion/react';
import type { MouseEvent } from 'react';
import type {
  ChartData,
  CodeData,
  DiagramData,
  DocumentData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { CodeViewport } from '../primitives/CodeViewport';
import { DiagramPrimitive } from '../primitives/DiagramPrimitive';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { SurfaceBoundary } from './SurfaceBoundary';

function FocusedObject({ object }: { object: SceneObject }) {
  switch (object.type) {
    case 'chart':
      return <ChartPrimitive data={object.data as ChartData} focused />;
    case 'diagram':
      return <DiagramPrimitive data={object.data as DiagramData} focused />;
    case 'document':
      return <DocumentViewport data={object.data as DocumentData} focused />;
    case 'code':
      return <CodeViewport data={object.data as CodeData} focused />;
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

export function FocusLayer({ object, onClose }: { object: SceneObject | null; onClose: () => void }) {
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
              <FocusedObject object={object} />
            </SurfaceBoundary>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
