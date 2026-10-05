import { AnimatePresence, motion } from 'motion/react';
import type { MouseEvent } from 'react';
import type {
  CalendarData,
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
  InboxData,
  TasksData,
  TimerData,
  WeatherData,
} from '../controller/types';
import { markedItem, noteTarget } from '../app/noteItems';
import { anchoredNote, cast, objectsOfType } from '../app/sceneModel';
import { chartNoteAnchors } from './ChartNotes';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { CalendarPrimitive } from '../primitives/CalendarPrimitive';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { CodeViewport } from '../primitives/CodeViewport';
import { DiagramObject } from './DiagramObject';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { ImagePrimitive } from '../primitives/ImagePrimitive';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { TablePrimitive } from '../primitives/TablePrimitive';
import { TasksPrimitive } from '../primitives/TasksPrimitive';
import { InboxPrimitive } from '../primitives/InboxPrimitive';
import { TimerPrimitive } from '../primitives/TimerPrimitive';
import { WeatherPrimitive } from '../primitives/WeatherPrimitive';
import { SurfaceBoundary } from './SurfaceBoundary';

/**
 * The notes focus keeps beside an object: the ones the scene draws about
 * it, so a note never goes when its object takes the stage. On a chart,
 * every note that names it (the scene lays each one over it); on any other
 * object, the first note that names it (`anchoredNote`, the one the rail
 * shows when the object is the primary). Focus gives the
 * object the stage and the rail goes, so the notes come with it, in a panel
 * of their own beside or under it, and what they name stays marked in it:
 * a chart's point its ring or outline and printed value, a diagram's node
 * or actor, a list's item, its NOTE marker, the view opening on it. A
 * focused note has none: it is the note.
 */
export function focusNotes(state: ControllerState, object: SceneObject | null): Array<SceneObject<NoteData>> {
  if (!object || object.type === 'note') return [];
  const notes = objectsOfType<NoteData>(state, 'note');
  if (object.type === 'chart') return notes.filter((note) => note.data.anchor?.target === object.id);
  const note = anchoredNote(notes, object.id);
  return note ? [note] : [];
}

// What the notes kept beside the object name in it, marked in focus as in
// the scene: a chart's points (`chartNoteAnchors`), a diagram's node or
// actor (the first note's), a list's item (`marked`, `markedItem`).
function FocusedObject({ object, notes, marked }: { object: SceneObject; notes: Array<SceneObject<NoteData>>; marked?: string }) {
  const note = notes[0]?.data ?? null;
  switch (object.type) {
    case 'chart':
      return <ChartPrimitive data={object.data as ChartData} focused named={chartNoteAnchors(cast.chart(object), notes.map((each) => ({ key: each.id, data: each.data, object: each })))} />;
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
    case 'calendar':
      return <CalendarPrimitive data={object.data as CalendarData} marked={marked} focused />;
    case 'tasks':
      return <TasksPrimitive data={object.data as TasksData} variant="focus" marked={marked} />;
    case 'inbox':
      return <InboxPrimitive data={object.data as InboxData} marked={marked} />;
    case 'timer':
      return <TimerPrimitive data={object.data as TimerData} marked={marked} />;
    case 'weather':
      return <WeatherPrimitive data={object.data as WeatherData} marked={marked} />;
    default:
      return null;
  }
}

// Where the notes stand is the focus box's geometry, in the stylesheet
// (`.focus-layer__content--noted`): beside a wide object, as the rail is,
// and under a tall one. Each card names what its note is about in the
// object's words, as the rail card does (`noteTarget`).
export function FocusLayer({ object, notes = [], onClose }: { object: SceneObject | null; notes?: Array<SceneObject<NoteData>>; onClose: () => void }) {
  const noted = notes.length > 0;
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
            className={`focus-layer__content focus-layer__content--${object.type}${noted ? ' focus-layer__content--noted' : ''}`}
            layoutId={`switchboard-object-${object.id}`}
            transition={{ layout: { duration: 0.46, ease: [0.22, 0.61, 0.36, 1] } }}
          >
            <div className="focus-layer__header tech micro">
              <span>FOCUS / {object.type.toUpperCase()}</span>
              <button type="button" onClick={onClose}>RETURN / ESC</button>
            </div>
            <SurfaceBoundary surfaceId={object.id} resetKey={object}>
              <FocusedObject object={object} notes={notes} marked={markedItem(notes[0]?.data, object.id)} />
            </SurfaceBoundary>
            {noted ? (
              <aside className="focus-layer__note" data-notes={notes.length}>
                {notes.map((note) => (
                  <SurfaceBoundary key={note.id} surfaceId={note.id} resetKey={note}>
                    <AnnotationCard data={note.data} {...noteTarget(object, note.data)} />
                  </SurfaceBoundary>
                ))}
              </aside>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
