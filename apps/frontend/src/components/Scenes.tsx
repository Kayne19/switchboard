import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useCallback, useState, type ReactNode } from 'react';
import type {
  ChartData,
  CodeData,
  ControllerState,
  DiagramObjectData,
  DocumentData,
  ImageData,
  MessageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
  TableData,
} from '../controller/types';
import { RUNTIME_CONVERSATION_ID } from '../controller/types';
import { markedItem, noteItemTarget } from '../app/noteItems';
import { anchoredNote, besideVisuals, buildCompositionModel, cast, objectsOfType, primaryObject, VISUAL_TYPES, type SceneKind } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { chartKind, chartTargetText } from '../primitives/chartGeometry';
import { CodeViewport } from '../primitives/CodeViewport';
import { DamoclesPresence } from '../primitives/DamoclesPresence';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { ImagePrimitive } from '../primitives/ImagePrimitive';
import { LiveChatCard } from '../primitives/LiveChatCard';
import { SpokenLog } from '../primitives/SpokenLog';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { SceneFooter } from '../primitives/SceneFooter';
import { TablePrimitive } from '../primitives/TablePrimitive';
import { TasksPrimitive, taskCounts } from '../primitives/TasksPrimitive';
import { InboxPrimitive, inboxCounts } from '../primitives/InboxPrimitive';
import { TemporaryAssistantList, temporaryAssistantFrame, type TemporaryAssistantType } from '../primitives/TemporaryAssistantList';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { TechFrame } from '../primitives/TechFrame';
import { ToolActivity } from '../primitives/ToolActivity';
import { TranscriptToggle } from '../primitives/TranscriptToggle';
import { ChartNotes, chartNoteAnchors, type ChartNote } from './ChartNotes';
import { DiagramObject } from './DiagramObject';
import { SurfaceBoundary } from './SurfaceBoundary';

/** A text field an object's data may carry for the scene frame, or undefined
 * when that shape has none. */
function frameText(data: unknown, field: 'title' | 'subject' | 'label' | 'subtitle' | 'context'): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

export interface SceneProps {
  /** The composition to draw; the shell keeps one page for every kind. */
  kind: SceneKind;
  state: ControllerState;
  onToggleListening: () => void;
  onFocus: (id: string | null) => void;
  /** Opens the conversation history drawer; absent while there is no conversation. */
  onOpenHistory?: () => void;
  setTranscriptOpen: (open: boolean) => void;
}

// The conversation's corner accents, from #conversation .corner-a / .corner-b
// in reference/lineage/approved-v16-controller.html. They belong to this
// composition only; the content scenes are framed by their objects instead.
function ConversationCorners() {
  return (
    <>
      <svg className="corner-mark corner-mark--top" viewBox="0 0 320 140" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 36 H52 V0 M52 16 H220 L250 46 H320" />
      </svg>
      <svg className="corner-mark corner-mark--bottom" viewBox="0 0 260 110" preserveAspectRatio="none" aria-hidden="true">
        <path d="M260 64 H202 V110 M202 91 H50 L18 59 H0" />
      </svg>
    </>
  );
}

function annotationForScene(
  state: ControllerState,
  noteObject: SceneObject<NoteData> | undefined,
  liveMessage: MessageData | null,
): NoteData | null {
  // Notes are durable display objects. A later chat response may supply a
  // transient explanation only when no note is present; it must never mutate
  // or visually replace an explicit note. A spoken reply already reads in the
  // live chat card when the scene shows one, so the slot then carries only
  // speech the card does not: an agent `say`, or an error on the line.
  if (noteObject) return noteObject.data;
  if (!state.speech) return null;
  if (liveMessage && state.speech.target === RUNTIME_CONVERSATION_ID) return null;
  return { tag: 'DAMOCLES / EXPLANATION', segments: [{ text: state.speech.text }] };
}

function noteForTarget(
  notes: Array<SceneObject<NoteData>>,
  targetId: string,
): SceneObject<NoteData> | undefined {
  return anchoredNote(notes, targetId)
    ?? notes.find((note) => !note.data.anchor)
    ?? notes[0];
}

// The current assistant turn, for the live chat card. Only the runtime
// conversation counts: an agent may name any object `message`, and that is
// not a chat turn. Before the first response there is nothing to show.
function liveChatMessage(state: ControllerState): MessageData | null {
  const object = state.runtimeObjects[RUNTIME_CONVERSATION_ID];
  if (object?.type !== 'message') return null;
  const message = cast.message(object).data;
  return message.segments.length > 0 ? message : null;
}

function sceneCaption(object: SceneObject, fallback: string): string {
  const caption = (object.data as { caption?: unknown }).caption;
  return typeof caption === 'string' && caption.trim() ? caption : fallback;
}

function ObjectSurface({ object, children }: { object: SceneObject; children: ReactNode }) {
  return (
    <SurfaceBoundary surfaceId={object.id} resetKey={object}>
      {children}
    </SurfaceBoundary>
  );
}

interface ExplanationProps {
  note: NoteData | null;
  noteObject?: SceneObject<NoteData>;
  onFocus: (id: string | null) => void;
  onOpenHistory?: () => void;
}

// The explanation beside content, shared by every rail composition. It stays
// mounted while its words change, so an update patches the text in place;
// it resolves in and out only when an explanation appears or goes away. Its
// layout animates position only: animating its size on a text change scales
// the text while it reflows, which reads as a twitch.
function RailNote({ note, noteObject, onFocus, onOpenHistory, target, itemMarked }: ExplanationProps & { target?: string; itemMarked?: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {note ? (
        <ObjectMotion key="rail-note" objectId={noteObject?.id ?? 'speech-note'} className="rail-note" layout="position">
          <SurfaceBoundary surfaceId={noteObject?.id ?? 'speech-note'} resetKey={noteObject ?? note}>
            <AnnotationCard
              data={note}
              onFocus={noteObject ? () => onFocus(noteObject.id) : undefined}
              onOpenHistory={noteObject ? undefined : onOpenHistory}
              target={target}
              itemMarked={itemMarked}
            />
          </SurfaceBoundary>
        </ObjectMotion>
      ) : null}
    </AnimatePresence>
  );
}

// Progress objects the main column has no slot for, each in a bounded block
// in the rail, so an accepted progress object is never lost to the layout.
function RailProgress({ progressList, onFocus }: { progressList: Array<SceneObject<ProgressData>>; onFocus: (id: string | null) => void }) {
  return (
    <>
      {progressList.map((progress) => (
        <ObjectMotion key={progress.id} objectId={progress.id} className="rail-progress">
          <ObjectSurface object={progress}>
            <FocusableSurface onActivate={() => onFocus(progress.id)} ariaLabel="Expand progress">
              <ProgressPrimitive data={progress.data} variant="rail" />
            </FocusableSurface>
          </ObjectSurface>
        </ObjectMotion>
      ))}
    </>
  );
}

interface RailDetailsProps {
  state: ControllerState;
  metrics: Array<SceneObject<MetricData>>;
  note: NoteData | null;
  noteObject?: SceneObject<NoteData>;
  progressList: Array<SceneObject<ProgressData>>;
  onFocus: (id: string | null) => void;
  onOpenHistory?: () => void;
}

// A rail note about a chart on stage names the category it points at, as
// the same note on the chart does; one about an item of a list (a task, a
// message, an event, a timer, a forecast hour or day) names the item, which
// is then marked where its object is drawn.
function railNoteTarget(state: ControllerState, note: NoteData | null): { target?: string; itemMarked: boolean } {
  const anchor = note?.anchor;
  const named = anchor ? state.agentObjects[anchor.target] : undefined;
  if (!anchor || !named) return { itemMarked: false };
  if (named.type === 'chart') return { target: chartTargetText(anchor, (named as SceneObject<ChartData>).data), itemMarked: false };
  const item = noteItemTarget(named, note);
  return { target: item, itemMarked: item !== undefined };
}

// The details column beside every content visual: the metrics and any
// progress the main column has no slot for, one stack of instruments read
// the same way, then the live response, the note, and tool activity. It is
// a permanent slot; an empty one renders nothing, and
// the activity panel can linger after its end without the wrapper
// unmounting it first.
function RailDetails({ state, metrics, note, noteObject, progressList, onFocus, onOpenHistory }: RailDetailsProps) {
  const liveMessage = liveChatMessage(state);
  // The response and the note stretch into the column's free space, so while
  // either is shown the activity slot stays reserved and a tool starting or
  // clearing never resizes them. Metrics and progress keep their own size at
  // the top and are not moved by a panel below them.
  const reserveActivity = liveMessage !== null || note !== null;
  return (
    <div className="content-rail__details">
      {metrics.length > 0 ? <MetricsPrimitive metrics={metrics} variant="rail" /> : null}
      <RailProgress progressList={progressList} onFocus={onFocus} />
      {liveMessage ? <LiveChatCard message={liveMessage} onOpenHistory={onOpenHistory} /> : null}
      <RailNote note={note} noteObject={noteObject} onFocus={onFocus} onOpenHistory={onOpenHistory} {...railNoteTarget(state, note)} />
      <ToolActivity activity={state.activity} reserveSpace={reserveActivity} />
    </div>
  );
}

// One object drawn inside a composed workspace, as the primary or in the aux
// row beneath it. A metric and a progress change with the slot: the aux row
// has no room for a whole step list. `marked` is the item the drawn note
// names in the object (`markedItem`), which the object marks.
function composedPrimitive(object: SceneObject, slot: 'primary' | 'aux', marked?: string) {
  switch (object.type) {
    case 'chart':
      return <ChartPrimitive data={(object as SceneObject<ChartData>).data} />;
    case 'diagram':
      return <DiagramObject data={(object as SceneObject<DiagramObjectData>).data} id={object.id} />;
    case 'document':
      return <DocumentViewport data={(object as SceneObject<DocumentData>).data} />;
    case 'code':
      return <CodeViewport data={(object as SceneObject<CodeData>).data} />;
    case 'table':
      return <TablePrimitive data={(object as SceneObject<TableData>).data} />;
    case 'image':
      return <ImagePrimitive data={(object as SceneObject<ImageData>).data} />;
    case 'metric':
      return <MetricsPrimitive metrics={[object as SceneObject<MetricData>]} variant={slot === 'primary' ? 'primary' : undefined} />;
    case 'progress':
      return <ProgressPrimitive data={(object as SceneObject<ProgressData>).data} variant={slot === 'aux' ? 'compact' : 'full'} />;
    case 'note':
      return <AnnotationCard data={(object as SceneObject<NoteData>).data} />;
    // TEMPORARY (pa-contract): replaced by the render slice, a primitive per type.
    case 'calendar':
      return <TemporaryAssistantList type="calendar" data={object.data} marked={marked} />;
    case 'tasks':
      return <TasksPrimitive data={cast.tasks(object).data} variant={slot === 'aux' ? 'compact' : 'full'} marked={marked} />;
    case 'timer':
      return <TemporaryAssistantList type="timer" data={object.data} marked={marked} />;
    case 'weather':
      return <TemporaryAssistantList type="weather" data={object.data} marked={marked} />;
    case 'inbox':
      return <InboxPrimitive data={cast.inbox(object).data} variant={slot === 'aux' ? 'compact' : 'full'} marked={marked} />;
    default:
      return null;
  }
}

// Which chart panel each note is shown on: the chart it names, a compare
// chart's included, and otherwise the primary. Every note is shown -- a
// second note on the chart is annotated beside the first, not dropped --
// and with no note object on stage, a spoken explanation stands in on the
// primary. The first note that names a visual on stage that is not a chart
// (one in the aux row, say) is about that visual, not a chart: it is left
// for the rail.
function chartNotesByPanel(
  state: ControllerState,
  charts: Array<SceneObject<ChartData>>,
  primary: SceneObject<ChartData>,
): { byPanel: Map<string, ChartNote[]>; offCharts?: ChartNote } {
  const byPanel = new Map<string, ChartNote[]>();
  const add = (chartId: string, note: ChartNote) => byPanel.set(chartId, [...(byPanel.get(chartId) ?? []), note]);
  let offCharts: ChartNote | undefined;
  const noteObjects = objectsOfType<NoteData>(state, 'note');
  for (const object of noteObjects) {
    const targetId = object.data.anchor?.target;
    const named = targetId ? state.agentObjects[targetId] : undefined;
    if (!offCharts && named && named.type !== 'chart' && named.id !== object.id) {
      offCharts = { key: object.id, data: object.data, object };
      continue;
    }
    const target = charts.find((chart) => chart.id === targetId) ?? primary;
    add(target.id, { key: object.id, data: object.data, object });
  }
  if (noteObjects.length === 0) {
    const spoken = annotationForScene(state, undefined, liveChatMessage(state));
    if (spoken) add(primary.id, { key: 'speech-note', data: spoken });
  }
  return { byPanel, offCharts };
}

/** The note a chart leaves out for the rail, and the chart that said so. */
interface ChartRailNote {
  chart: string;
  note: string;
}

// What a content scene fills the shell with: the text of its frame, its main
// slot, the visuals that slot leaves out, and the objects the rail carries
// for it. The shell draws the rest.
interface SceneContent {
  title: string;
  subtitle: string;
  context: string;
  footer: string;
  caption: string;
  main: ReactNode;
  /** Objects on stage that `main` does not draw and the rail does not
   * carry: the shell lays them in the aux row under it (`MainWithAux`), so
   * none is lost to the layout. */
  aux: SceneObject[];
  /** A variant of the column `main` and the aux row share, if the scene
   * has one. */
  mainVariant?: string;
  metrics: Array<SceneObject<MetricData>>;
  note: NoteData | null;
  noteObject?: SceneObject<NoteData>;
  progressList: Array<SceneObject<ProgressData>>;
}

// `railNote` is the note a chart has said, through `onRailNote`, it leaves
// out for the rail; the rail shows it while that chart is the primary.
function trainingContent(
  { state, onFocus, onOpenHistory }: SceneProps,
  railNote: ChartRailNote | null,
  onRailNote: (chartId: string, key: string, away: boolean) => void,
): SceneContent | null {
  const charts = objectsOfType<ChartData>(state, 'chart');
  const [firstProgress, ...railProgress] = objectsOfType<ProgressData>(state, 'progress');
  const primary = charts.find((chart) => chart.role === 'primary') ?? charts[0];
  if (!primary) return null;
  // Every chart is drawn here, the primary's neighbours beside it; any other
  // visual goes in the aux row under them. With visuals there, the progress
  // that sits under the charts joins them in the row, as progress does in
  // the composed workspace, so the charts keep the main slot's share of a
  // short stage instead of giving it to the bar and its steps.
  const besideCharts = besideVisuals(buildCompositionModel(state)).filter((object) => object.type !== 'chart');
  const progress = besideCharts.length > 0 ? undefined : firstProgress;
  // The notes lie over the panel of the chart they annotate rather than in a
  // band that shrinks it; the layer keeps them clear of one another, of the
  // points they name, and of the data the chart draws.
  const { byPanel: notesByPanel, offCharts } = chartNotesByPanel(state, charts, primary);
  // The rail's one note slot: a note about a visual off the charts, else
  // the note the primary chart leaves out so the rest have clear places.
  const inRail =
    offCharts ?? (railNote?.chart === primary.id ? (notesByPanel.get(primary.id) ?? []).find((note) => note.key === railNote.note) : undefined);
  // Frame text the chart leaves out names what it is -- its kind -- and
  // nothing more: a bar chart of test durations is not a training run.
  const kind = chartKind(primary.data).toUpperCase();
  return {
    title: primary.data.title ?? `CHART / ${kind}`,
    subtitle: primary.data.subtitle ?? 'SERIES / COMPOSED',
    context: primary.data.context ?? 'CHART',
    footer: 'DISPLAY / COMPOSED',
    caption: sceneCaption(primary, `PRIMARY / ${kind} CHART`),
    metrics: objectsOfType<MetricData>(state, 'metric'),
    // The notes sit on the charts here; the rail carries only the one the
    // primary leaves out, or one about a visual that is not a chart.
    note: inRail?.data ?? null,
    noteObject: inRail?.object,
    progressList: railProgress,
    aux: firstProgress && !progress ? [...besideCharts, firstProgress] : besideCharts,
    main: (
      <motion.div className="content-main training-main" layout>
        <div className={`training-charts${charts.length > 1 ? ' training-charts--compare' : ''}`}>
          <AnimatePresence mode="popLayout" initial={false}>
            {charts.map((chart) => {
              const notes = notesByPanel.get(chart.id) ?? [];
              return (
                <ObjectMotion key={chart.id} objectId={chart.id} className="chart-object" data-chart-id={chart.id}>
                  <TechFrame variant="panel" />
                  <ObjectSurface object={chart}>
                    <FocusableSurface onActivate={() => onFocus(chart.id)} ariaLabel={`Expand ${chart.data.title ?? 'chart'}`}>
                      <ChartPrimitive data={chart.data} named={chartNoteAnchors(chart, notes)} />
                    </FocusableSurface>
                  </ObjectSurface>
                  {notes.length > 0 ? (
                    <ChartNotes
                      chart={chart}
                      notes={notes}
                      onFocus={onFocus}
                      onOpenHistory={onOpenHistory}
                      onRailNote={chart.id === primary.id && !offCharts ? onRailNote : undefined}
                    />
                  ) : null}
                  {chart.role === 'compare' ? <div className="compare-label tech micro">COMPARE / {chart.data.compareLabel ?? 'RUN'}</div> : null}
                </ObjectMotion>
              );
            })}
          </AnimatePresence>
        </div>
        {progress ? (
          <ObjectMotion objectId={progress.id} className="training-progress">
            <ObjectSurface object={progress}>
              <FocusableSurface onActivate={() => onFocus(progress.id)} ariaLabel="Expand progress">
                <ProgressPrimitive data={progress.data} />
              </FocusableSurface>
            </ObjectSurface>
          </ObjectMotion>
        ) : null}
      </motion.div>
    ),
  };
}

// A diagram, document, code, table, or image object fills the main slot,
// its note in the rail -- unless the diagram places the note as its own
// callout -- and every other visual in the aux row under it.
function objectContent({ state, onFocus }: SceneProps, onCalloutChange: (placed: boolean) => void): SceneContent | null {
  const primary = primaryObject(state);
  if (!primary) return null;
  const noteObject = noteForTarget(objectsOfType<NoteData>(state, 'note'), primary.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  // What the shell places around the main slot: the aux row under it (every
  // visual beside the primary) and the rail beside it.
  const rail = {
    aux: besideVisuals(buildCompositionModel(state)),
    metrics: objectsOfType<MetricData>(state, 'metric'),
    note,
    noteObject,
    progressList: objectsOfType<ProgressData>(state, 'progress'),
  };
  const slot = (className: string, body: ReactNode, frame: ReactNode = null) => (
    <ObjectMotion objectId={primary.id} className={`content-main ${className}`}>
      {frame}
      <ObjectSurface object={primary}>
        <FocusableSurface onActivate={() => onFocus(primary.id)} ariaLabel={`Expand ${primary.type}`}>
          {body}
        </FocusableSurface>
      </ObjectSurface>
    </ObjectMotion>
  );
  switch (primary.type) {
    case 'diagram': {
      const { data } = cast.diagram(primary);
      const sequence = data.mode === 'sequence';
      return {
        ...rail,
        title: data.title ?? (sequence ? 'SYSTEM / SEQUENCE' : 'SYSTEM / DIAGRAM'),
        subtitle: data.subtitle ?? (sequence ? 'SEQUENCE / COMPOSED' : 'GRAPH / COMPOSED'),
        context: data.context ?? (sequence ? 'SEQUENCE' : 'SYSTEM MAP'),
        footer: sequence ? 'DISPLAY / SEQUENCE' : 'DISPLAY / SYSTEM MAP',
        caption: sceneCaption(primary, sequence ? 'TRACE / MESSAGE ORDER' : 'TRACE / ACTIVE ROUTE'),
        main: slot(
          'diagram-object',
          <DiagramObject data={data} id={primary.id} note={note} onCalloutChange={onCalloutChange} />,
          <TechFrame variant="rails" />,
        ),
      };
    }
    case 'document': {
      const { data } = cast.document(primary);
      return {
        ...rail,
        title: `DOCUMENT / ${data.kind?.toUpperCase() ?? 'CONTENT'}`,
        subtitle: 'CONTENT / ORIGINAL',
        context: data.context ?? 'DOCUMENT',
        footer: 'CONTENT / ORIGINAL EMAIL',
        caption: sceneCaption(primary, 'CHROME / SWITCHBOARD'),
        main: slot('document-object', <DocumentViewport data={data} />),
      };
    }
    case 'code': {
      const { data } = cast.code(primary);
      return {
        ...rail,
        title: data.title ?? 'SOURCE / LIVE',
        subtitle: data.file ?? 'SOURCE',
        context: data.context ?? 'SOURCE',
        footer: 'FRAME / INTERRUPTED RAILS',
        caption: sceneCaption(primary, 'DISPLAY / SOURCE'),
        main: slot('code-object', <CodeViewport data={data} />),
      };
    }
    case 'table': {
      const { data } = cast.table(primary);
      return {
        ...rail,
        title: data.title ?? 'DATA / TABLE',
        subtitle: data.subtitle ?? `${data.rows.length} ROWS / ${data.columns.length} COLUMNS`,
        context: data.context ?? 'TABLE',
        footer: 'FRAME / INTERRUPTED RAILS',
        caption: sceneCaption(primary, 'DISPLAY / TABLE'),
        main: slot('table-object', <TablePrimitive data={data} />),
      };
    }
    case 'image': {
      // The figure's own words head the scene; its alt text stands in for
      // a title it was not given.
      const { data } = cast.image(primary);
      return {
        ...rail,
        title: data.title ?? data.alt,
        subtitle: data.subtitle ?? `IMAGE / ${data.format.toUpperCase()}`,
        context: data.context ?? 'FIGURE',
        footer: 'DISPLAY / FIGURE',
        caption: sceneCaption(primary, `FIGURE / ${data.format.toUpperCase()}`),
        main: slot('image-object', <ImagePrimitive data={data} />, <TechFrame variant="panel" />),
      };
    }
    case 'tasks': {
      // A to-do list heads the scene with its own words, else what it holds.
      const { data } = cast.tasks(primary);
      const counts = taskCounts(data);
      return {
        ...rail,
        title: data.title ?? 'TASKS / TO DO',
        subtitle: data.subtitle ?? `${counts.open} OPEN / ${counts.done} DONE`,
        context: data.context ?? 'TASKS',
        footer: 'DISPLAY / TASKS',
        caption: sceneCaption(primary, `TASKS / ${data.items.length} ${data.items.length === 1 ? 'ITEM' : 'ITEMS'}`),
        main: slot('tasks-object', <TasksPrimitive data={data} marked={markedItem(note, primary.id)} />, <TechFrame variant="panel" />),
      };
    }
    case 'inbox': {
      const { data } = cast.inbox(primary);
      const counts = inboxCounts(data);
      return {
        ...rail,
        title: data.title ?? 'INBOX / MESSAGES',
        subtitle: data.subtitle ?? `${counts.messages} ${counts.messages === 1 ? 'MESSAGE' : 'MESSAGES'} / ${counts.unread} UNREAD`,
        context: data.context ?? 'INBOX',
        footer: 'DISPLAY / INBOX',
        caption: sceneCaption(primary, `INBOX / ${counts.messages} ${counts.messages === 1 ? 'MESSAGE' : 'MESSAGES'}`),
        main: slot('inbox-object', <InboxPrimitive data={data} marked={markedItem(note, primary.id)} />, <TechFrame variant="panel" />),
      };
    }
    // TEMPORARY (pa-contract): replaced by the render slice, a primitive per type.
    case 'calendar':
    case 'timer':
    case 'weather': {
      const type = primary.type as TemporaryAssistantType;
      const kind = type.toUpperCase();
      return {
        ...rail,
        ...temporaryAssistantFrame(type, primary.data),
        footer: `DISPLAY / ${kind}`,
        caption: sceneCaption(primary, `${kind} / FIELDS AS SENT`),
        main: slot(
          'temporary-assistant-object',
          <TemporaryAssistantList type={type} data={primary.data} marked={markedItem(note, primary.id)} />,
          <TechFrame variant="panel" />,
        ),
      };
    }
    default:
      return null;
  }
}

// ---- The aux row: every visual a main slot does not draw ----

// The row under a primary: each object the main slot does not draw and the
// rail does not carry gets a framed cell of its own, so an accepted object is
// never lost to the layout. A visual keeps a readable floor in its cell; a
// row with no room for every cell scrolls inside itself rather than squeezing
// one to nothing (`.composed-aux` in styles/index.css). Each object marks
// the item the rail's note names in it (`marked`).
function AuxRow({
  objects,
  onFocus,
  marked,
}: {
  objects: SceneObject[];
  onFocus: (id: string | null) => void;
  marked: (objectId: string) => string | undefined;
}) {
  return (
    <div className="composed-aux">
      {objects.map((object) => (
        <ObjectMotion
          key={object.id}
          objectId={object.id}
          className={`composed-aux-object composed-aux-object--${object.type}${VISUAL_TYPES.has(object.type) ? ' composed-aux-object--visual' : ''}`}
        >
          <TechFrame variant="panel" />
          <ObjectSurface object={object}>
            <FocusableSurface onActivate={() => onFocus(object.id)} ariaLabel={`Expand ${object.type}`}>
              {composedPrimitive(object, 'aux', marked(object.id))}
            </FocusableSurface>
          </ObjectSurface>
        </ObjectMotion>
      ))}
    </div>
  );
}

// The main column of every content scene: the scene's own main slot over
// the aux row. The slot sits here whether or not the row is shown, so an
// object arriving beside the primary resizes the primary in place rather
// than redrawing it; alone, the slot fills the column as it always did. The
// primary keeps the larger share and the row takes what it needs up to its
// cap (`.composed-main`).
function MainWithAux({
  variant,
  aux,
  onFocus,
  marked,
  children,
}: {
  variant?: string;
  aux: SceneObject[];
  onFocus: (id: string | null) => void;
  marked: (objectId: string) => string | undefined;
  children: ReactNode;
}) {
  return (
    <motion.div className={`content-main composed-main${variant ? ` ${variant}` : ''}`} layout>
      {children}
      {aux.length > 0 ? <AuxRow objects={aux} onFocus={onFocus} marked={marked} /> : null}
    </motion.div>
  );
}

// ---- End of the aux row ----

// Any mix of objects: the primary, or a cluster of primary metrics, over an
// aux row of everything the rail does not carry.
function composedContent({ state, onFocus }: SceneProps): SceneContent | null {
  const comp = buildCompositionModel(state);
  const primary = comp.primary;
  if (!primary) return null;

  const primaryMetrics = comp.primaryMetrics;
  const isMetricPrimary = primary.type === 'metric' || primaryMetrics.length > 0;

  const noteObjects = comp.allAgentObjects.filter((object) => object.type === 'note') as Array<SceneObject<NoteData>>;
  const noteObject = noteForTarget(noteObjects, primary.id);
  const noteIsPrimary = noteObject?.id === primary.id;
  const metrics = comp.allAgentObjects.filter((o) => o.type === 'metric') as Array<SceneObject<MetricData>>;
  const progressList = comp.allAgentObjects.filter((o) => o.type === 'progress') as Array<SceneObject<ProgressData>>;
  const primaryMetricIds = new Set(primaryMetrics.map((m) => m.id));
  const note = noteIsPrimary ? null : annotationForScene(state, noteObject, liveChatMessage(state));
  // Everything the rail does not carry shares one visible aux row below the
  // primary -- compare objects, the other visuals beside it, and progress --
  // so an accepted object is never lost to the layout. Metrics and the note
  // stay in the rail; a compare metric or the rail's note is not drawn twice.
  const auxObjects: SceneObject[] = [
    ...comp.compare.filter((o) => o.type !== 'metric' && o.id !== noteObject?.id),
    ...besideVisuals(comp).filter((o) => o.role !== 'compare'),
    ...progressList.filter((p) => p.id !== primary.id && !comp.compare.some((c) => c.id === p.id)),
  ];

  return {
    // The same precedence the backend's view summary reports to the agent.
    title: frameText(primary.data, 'title') ?? frameText(primary.data, 'subject') ?? frameText(primary.data, 'label') ?? 'COMPOSED WORKSPACE',
    subtitle: frameText(primary.data, 'subtitle') ?? 'STRUCTURED SCENE',
    context: frameText(primary.data, 'context') ?? 'COMPOSED',
    footer: 'DISPLAY / COMPOSED',
    caption: sceneCaption(primary, 'SYSTEM / ACTIVE'),
    metrics: isMetricPrimary ? metrics.filter((metric) => !primaryMetricIds.has(metric.id)) : metrics,
    note,
    noteObject: noteIsPrimary ? undefined : noteObject,
    progressList: [],
    aux: auxObjects,
    mainVariant: isMetricPrimary ? 'composed-main--metric-primary' : undefined,
    main: (
      <ObjectMotion
        objectId={primaryMetrics.length > 1 ? 'primary-metric-cluster' : primary.id}
        layoutId={primaryMetrics.length > 1 ? 'switchboard-primary-metric-cluster' : undefined}
        className={`composed-primary-object composed-primary-object--${primary.type}${primaryMetrics.length > 1 ? ' composed-primary-object--cluster' : ''}`}
      >
        <TechFrame variant="panel" />
        {primaryMetrics.length > 1 ? (
          <SurfaceBoundary surfaceId="primary-metric-cluster" resetKey={state.agentObjects}>
            <div className="focusable-content">
              <MetricsPrimitive
                metrics={primaryMetrics}
                variant="primary"
                onFocus={onFocus}
              />
            </div>
          </SurfaceBoundary>
        ) : (
          <ObjectSurface object={primary}>
            <FocusableSurface onActivate={() => onFocus(primary.id)} ariaLabel={`Expand ${primary.type}`}>
              {isMetricPrimary ? (
                <MetricsPrimitive
                  metrics={primaryMetrics.length > 0 ? primaryMetrics : [primary as SceneObject<MetricData>]}
                  variant="primary"
                  onFocus={onFocus}
                />
              ) : (
                composedPrimitive(primary, 'primary', markedItem(note, primary.id))
              )}
            </FocusableSurface>
          </ObjectSurface>
        )}
      </ObjectMotion>
    ),
  };
}

const FALLBACK_MESSAGE: MessageData = {
  context: 'OPERATOR LINE',
  tag: 'CURRENT RESPONSE / LIVE',
  segments: [{ text: 'Line open. Speak when ready.' }],
  channel: { name: 'VOICE', mode: 'PUSH-TO-TALK' },
  transcript: [],
};

// The conversation page's live box: the runtime conversation, or an agent
// message on stage. Status/activity speech is rendered as an annotation
// elsewhere; it must not replace the conversation's latest committed
// response. Before the first response the line carries no text, and this
// page alone says it is open.
function ConversationAnswer({ state }: { state: ControllerState }) {
  const comp = buildCompositionModel(state);
  const object = comp.runtimeConversation ?? (comp.primary?.type === 'message' ? comp.primary : null);
  const message = object ? cast.message(object).data : FALLBACK_MESSAGE;
  const segments = message.segments.length > 0 ? message.segments : FALLBACK_MESSAGE.segments;
  return (
    <>
      <ObjectMotion objectId={object?.id ?? 'conversation'} className="conversation-answer">
        <TechFrame variant="answer" />
        <SurfaceBoundary surfaceId={object?.id ?? 'conversation'} resetKey={object ?? message}>
          <div className="conversation-answer__tag tech micro">{message.tag ?? 'CURRENT RESPONSE / 01'}</div>
          <SpokenLog message={{ ...message, segments }} className="conversation-answer__text" innerClassName="conversation-answer__text-inner" />
          <div className="conversation-answer__index tech micro">{message.caption ?? `${message.channel?.name ?? 'VOICE'} / LIVE`}</div>
        </SurfaceBoundary>
      </ObjectMotion>
      <div className="conversation-channel tech micro">
        CHANNEL / {message.channel?.name ?? 'VOICE'}<br />MODE / {message.channel?.mode ?? 'HANDS-FREE'}
      </div>
    </>
  );
}

function sceneContent(
  props: SceneProps,
  onCalloutChange: (placed: boolean) => void,
  chartRailNote: ChartRailNote | null,
  onChartRailNote: (chartId: string, key: string, away: boolean) => void,
): SceneContent | null {
  switch (props.kind) {
    case 'idle':
    case 'conversation':
      return null;
    case 'training':
      return trainingContent(props, chartRailNote, onChartRailNote);
    case 'composed':
      return composedContent(props);
    default:
      return objectContent(props, onCalloutChange);
  }
}

/**
 * The page every scene shares (#121). It owns the frame, the Damocles
 * presence, the rail with its live box and tool activity, the corner text,
 * and the transcript entry point, so a feature that crosses scenes is added
 * here once. A scene only fills the main slot, chosen by the kind of its
 * primary object; a content kind with nothing to show draws the idle page.
 */
export function SceneShell(props: SceneProps) {
  const { kind, state, onToggleListening, onFocus, onOpenHistory, setTranscriptOpen } = props;
  const isPresent = useIsPresent();
  // A diagram can place its note as a callout beside the node it names; the
  // rail then leaves it out. A chart hands the rail the one note it leaves
  // out so the others have places clear of its data.
  const [calloutPlaced, setCalloutPlaced] = useState(false);
  const [chartRailNote, setChartRailNote] = useState<ChartRailNote | null>(null);
  // A chart says when a note leaves it and when it is back, and takes back
  // only its own: a chart on its way out may speak after the one that
  // replaced it, about the same note.
  const onChartRailNote = useCallback(
    (chart: string, note: string, away: boolean) =>
      setChartRailNote((current) => {
        const own = current?.chart === chart && current.note === note;
        if (away) return own ? current : { chart, note };
        return own ? null : current;
      }),
    [],
  );
  const content = sceneContent(props, setCalloutPlaced, chartRailNote, onChartRailNote);
  const layout = content ? 'content' : kind === 'conversation' ? 'conversation' : 'idle';
  const presence = (
    <DamoclesPresence
      listening={state.listening}
      onToggleListening={onToggleListening}
      context={content?.context}
      size={content ? 'rail' : layout === 'conversation' ? 'conversation' : 'idle'}
      showCaption={content !== null}
      activity={state.activity}
    />
  );

  return (
    <motion.section
      className={`scene scene--${layout}${content ? ` scene--${kind}` : ''}`}
      data-scene={content ? kind : layout}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {content ? (
        <>
          <div className="scene-heading">
            <div className="scene-heading__title tech">{content.title}</div>
            <div className="scene-heading__sub tech micro">{content.subtitle}</div>
          </div>
          <div className="content-grid">
            <MainWithAux variant={content.mainVariant} aux={content.aux} onFocus={onFocus} marked={(id) => markedItem(calloutPlaced ? null : content.note, id)}>
              {content.main}
            </MainWithAux>
            <motion.aside className="content-rail" layout>
              {presence}
              <RailDetails
                state={state}
                metrics={content.metrics}
                note={calloutPlaced ? null : content.note}
                noteObject={calloutPlaced ? undefined : content.noteObject}
                progressList={content.progressList}
                onFocus={onFocus}
                onOpenHistory={onOpenHistory}
              />
            </motion.aside>
          </div>
          <SceneFooter left={content.footer} right={content.caption} />
        </>
      ) : layout === 'conversation' ? (
        <>
          <ConversationCorners />
          <div className="conversation-presence-band">{presence}</div>
          <ConversationAnswer state={state} />
          <TranscriptToggle onOpen={() => setTranscriptOpen(true)} />
          <ToolActivity activity={state.activity} placement="conversation" />
        </>
      ) : (
        <>
          {presence}
          {/* The idle stage keeps the transcript toggle in its conversation-page
              place, hidden until the pointer reaches the bottom band, so the
              typed line is reachable before anyone has spoken. */}
          {isPresent ? <TranscriptToggle reveal="hover" onOpen={() => setTranscriptOpen(true)} /> : null}
        </>
      )}
    </motion.section>
  );
}
