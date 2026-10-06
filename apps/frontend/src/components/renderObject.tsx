import type { ReactNode } from 'react';
import type { NoteData, SceneObject } from '../controller/types';
import { markedItem, standingNoteTarget } from '../app/noteItems';
import { cast } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { CalendarPrimitive } from '../primitives/CalendarPrimitive';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { CodeViewport } from '../primitives/CodeViewport';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { ImagePrimitive } from '../primitives/ImagePrimitive';
import { InboxPrimitive } from '../primitives/InboxPrimitive';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import type { Slot } from '../primitives/slot';
import { TablePrimitive } from '../primitives/TablePrimitive';
import { TasksPrimitive } from '../primitives/TasksPrimitive';
import { TimerPrimitive } from '../primitives/TimerPrimitive';
import { WeatherPrimitive } from '../primitives/WeatherPrimitive';
import { chartNoteAnchors } from './ChartNotes';
import { DiagramObject } from './DiagramObject';

/** What an object is drawn with besides its slot. */
export interface ObjectContext {
  /** Every object on stage, by id: a note drawn as an object of its own names on its TARGET line the one it is about (`standingNoteTarget`). */
  onStage: Readonly<Record<string, SceneObject>>;
  /**
   * The notes the page draws about the object (the rail's, or those focus
   * keeps beside it), and the object marks what they name in it: a chart
   * the point of each (a bar outlined, its value printed; a point on a line
   * ringed), any other object what the first names (`markedItem`: a list's
   * item; a diagram's node or actor, with its NOTE marker).
   */
  notes: NoteData[];
  /** The main slot hears whether its graph placed the note as a callout beside the node it names, and the rail then leaves it out. Elsewhere the note is in a panel of its own, never on the drawing. */
  onCalloutChange?: (placed: boolean) => void;
}

/**
 * One object drawn for its slot: in the main slot of its own scene, as the
 * composed workspace's primary, in a cell of the aux row, and in focus, so
 * a type is drawn in one place for all four. The page draws a few things
 * itself, each with its own primitive's slot: the rail's metrics and
 * progress (`'rail'`), the composed workspace's metric primary or cluster
 * (`'primary'`, each metric expanding on a tap), and a chart's own page
 * (`trainingContent`), its charts with the notes laid over them and its
 * progress under them. A message is no object of this kind: it draws
 * nothing.
 */
export function renderObject(object: SceneObject, slot: Slot, { onStage, notes, onCalloutChange }: ObjectContext): ReactNode {
  const note = notes[0] ?? null;
  const marked = markedItem(note, object.id);
  switch (object.type) {
    case 'chart': {
      const chart = cast.chart(object);
      // `chartNoteAnchors` reads each note's data alone.
      return <ChartPrimitive data={chart.data} slot={slot} named={chartNoteAnchors(chart, notes.map((data, index) => ({ key: String(index), data })))} />;
    }
    case 'diagram':
      return <DiagramObject data={cast.diagram(object).data} id={object.id} slot={slot} note={note} onCalloutChange={onCalloutChange} />;
    case 'document':
      return <DocumentViewport data={cast.document(object).data} slot={slot} />;
    case 'code':
      return <CodeViewport data={cast.code(object).data} slot={slot} />;
    case 'table':
      return <TablePrimitive data={cast.table(object).data} slot={slot} />;
    case 'image':
      return <ImagePrimitive data={cast.image(object).data} slot={slot} />;
    case 'metric':
      return <MetricsPrimitive metrics={[cast.metric(object)]} slot={slot} />;
    case 'progress':
      return <ProgressPrimitive data={cast.progress(object).data} slot={slot} />;
    case 'note':
      return <AnnotationCard data={cast.note(object).data} named={standingNoteTarget(onStage, cast.note(object).data)} />;
    case 'calendar':
      return <CalendarPrimitive data={cast.calendar(object).data} slot={slot} marked={marked} />;
    case 'tasks':
      return <TasksPrimitive data={cast.tasks(object).data} slot={slot} marked={marked} />;
    case 'inbox':
      return <InboxPrimitive data={cast.inbox(object).data} slot={slot} marked={marked} />;
    case 'timer':
      return <TimerPrimitive data={cast.timer(object).data} slot={slot} marked={marked} />;
    case 'weather':
      return <WeatherPrimitive data={cast.weather(object).data} slot={slot} marked={marked} />;
    default:
      return null;
  }
}

/**
 * `renderObject` as a component, for a place that draws the object inside
 * an error boundary of its own (focus): a throw while choosing what to
 * draw then stays inside that boundary, as a throw in the primitive does.
 */
export function ObjectView({ object, slot, ...context }: { object: SceneObject; slot: Slot } & ObjectContext) {
  return renderObject(object, slot, context);
}
