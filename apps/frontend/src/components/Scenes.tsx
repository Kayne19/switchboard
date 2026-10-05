import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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
import { besideVisuals, buildCompositionModel, cast, objectsOfType, primaryObject, VISUAL_TYPES, type SceneKind } from '../app/sceneModel';
import { wantsStage, type StageGeometry } from '../app/stageFold';
import { StageDemandContext, type StageDemandListener } from '../hooks/useStageDemand';
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
  return notes.find((note) => note.data.anchor?.target === targetId)
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
function RailNote({ note, noteObject, onFocus, onOpenHistory, target }: ExplanationProps & { target?: string }) {
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
  /** The rail is folded to a strip under a primary that takes the stage's height: it shows the note, or the live response when there is no note, and nothing else. */
  folded?: boolean;
}

// A rail note about a chart on stage names the category it points at, as
// the same note on the chart does.
function railNoteTarget(state: ControllerState, note: NoteData | null): string | undefined {
  const named = note?.anchor ? state.agentObjects[note.anchor.target] : undefined;
  return named?.type === 'chart' && note?.anchor ? chartTargetText(note.anchor, (named as SceneObject<ChartData>).data) : undefined;
}

// The details column beside every content visual: the metrics and any
// progress the main column has no slot for, one stack of instruments read
// the same way, then the live response, the note, and tool activity. It is
// a permanent slot; an empty one renders nothing, and
// the activity panel can linger after its end without the wrapper
// unmounting it first.
function RailDetails({ state, metrics, note, noteObject, progressList, onFocus, onOpenHistory, folded = false }: RailDetailsProps) {
  const liveMessage = liveChatMessage(state);
  if (folded) {
    // The strip: the note, linked to what it names by its target line and
    // the marker on the item, or else the live response; the presence
    // beside it names the tool at work. The rest waits behind the handle.
    return (
      <div className="content-rail__details">
        {note ? null : liveMessage ? <LiveChatCard message={liveMessage} onOpenHistory={onOpenHistory} /> : null}
        <RailNote note={note} noteObject={noteObject} onFocus={onFocus} onOpenHistory={onOpenHistory} target={railNoteTarget(state, note)} />
      </div>
    );
  }
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
      <RailNote note={note} noteObject={noteObject} onFocus={onFocus} onOpenHistory={onOpenHistory} target={railNoteTarget(state, note)} />
      <ToolActivity activity={state.activity} reserveSpace={reserveActivity} />
    </div>
  );
}

// One object drawn inside a composed workspace, as the primary or in the aux
// row beneath it. A metric and a progress change with the slot: the aux row
// has no room for a whole step list.
function composedPrimitive(object: SceneObject, slot: 'primary' | 'aux') {
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
    default:
      return null;
  }
}

// ---- The aux row: every visual a main slot does not draw ----

// The row under a primary: each object the main slot does not draw and the
// rail does not carry gets a framed cell of its own, so an accepted object is
// never lost to the layout. A visual keeps a readable floor in its cell; a
// row with no room for every cell scrolls inside itself rather than squeezing
// one to nothing (`.composed-aux` in styles/index.css).
function AuxRow({ objects, onFocus }: { objects: SceneObject[]; onFocus: (id: string | null) => void }) {
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
              {composedPrimitive(object, 'aux')}
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
// The primary's own slot hears what its content asks of the stage
// (useStageDemand); the aux row's cells do not speak for it.
function MainWithAux({
  variant,
  aux,
  onFocus,
  onDemand,
  ref,
  children,
}: {
  variant?: string;
  aux: SceneObject[];
  onFocus: (id: string | null) => void;
  onDemand: StageDemandListener;
  ref?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <motion.div ref={ref} className={`content-main composed-main${variant ? ` ${variant}` : ''}`} layout>
      <StageDemandContext.Provider value={onDemand}>{children}</StageDemandContext.Provider>
      {aux.length > 0 ? <AuxRow objects={aux} onFocus={onFocus} /> : null}
    </motion.div>
  );
}

// ---- The rail folded under a primary that takes the stage's height ----

const pad2 = (count: number) => String(count).padStart(2, '0');

// What a folded rail keeps behind its handle, in the handle's words: the
// strip itself shows the note (or the live response) and Damocles, and the
// rest of a note held to its first lines.
function foldedItems(state: ControllerState, content: SceneContent, note: NoteData | null, noteCut: boolean): string[] {
  const items: string[] = [];
  if (noteCut) items.push(note ? 'NOTE' : 'LIVE');
  if (content.metrics.length > 0) items.push(`${pad2(content.metrics.length)} ${content.metrics.length === 1 ? 'METRIC' : 'METRICS'}`);
  if (content.progressList.length > 0) items.push('PROGRESS');
  if (note && liveChatMessage(state)) items.push('LIVE');
  if (state.activity) items.push('ACTIVITY');
  return items;
}

// Whether the folded strip holds its text to fewer lines than it has.
function useStripCut(railRef: RefObject<HTMLElement | null>, folded: boolean, text: unknown): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const rail = railRef.current;
    const element = folded ? rail?.querySelector<HTMLElement>('.content-rail__details :is(.annotation-card__text, .live-chat-card__text)') : null;
    if (!element) {
      setCut(false);
      return undefined;
    }
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [railRef, folded, text]);
  return cut;
}

// The rail's handle, over it whenever its primary can take the stage: on
// the folded strip it names what the rail keeps folded, and opens it; on
// the open rail it folds it again. A strip that keeps nothing folded has a
// rule there and no control.
function RailHandle({ open, items, onToggle }: { open: boolean; items: string[]; onToggle: () => void }) {
  if (!open && items.length === 0) {
    return (
      <div className="rail-handle rail-handle--bare" aria-hidden="true">
        <span className="rail-handle__rule" />
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`rail-handle rail-handle--${open ? 'open' : 'folded'}`}
      aria-expanded={open}
      aria-label={open ? 'Fold the rail' : 'Open the rail'}
      onClick={onToggle}
    >
      <span className="rail-handle__rule" aria-hidden="true" />
      <span className="rail-handle__label tech micro">{open ? 'FOLD' : items.join(' / ')}</span>
      <svg className="rail-handle__chevron" viewBox="0 0 8 6" aria-hidden="true">
        <path d="M 4 0 L 8 6 L 0 6 Z" />
      </svg>
    </button>
  );
}

// Whether the primary takes the stage's height (stageFold.ts). What it hears from the primary and measures of the column is
// kept out of render, and a decision that does not change renders nothing:
// a scene that never folds is drawn exactly as it was. The columns are
// read in layout pixels: a box in a shared-layout animation is scaled on
// screen, never in its offsets. The shared column is the probe, sized by
// the same rule as that grid row.
function useStageFold(
  active: boolean,
  railOpen: boolean,
  mainRef: RefObject<HTMLDivElement | null>,
  railRef: RefObject<HTMLElement | null>,
  probeRef: RefObject<HTMLDivElement | null>,
): { foldable: boolean; onDemand: StageDemandListener } {
  const [foldable, setFoldable] = useState(false);
  const demands = useRef(new Map<string, number>());
  const geometry = useRef<Omit<StageGeometry, 'excess'>>({ stacked: false, column: 0, shared: 0 });
  const staged = useRef(false);
  staged.current = foldable && !railOpen;
  const decide = useCallback(() => {
    const said = [...demands.current.values()];
    setFoldable(wantsStage({ ...geometry.current, excess: said.length > 0 ? Math.max(...said) : null }, staged.current));
  }, []);
  const onDemand = useCallback<StageDemandListener>(
    (key, excess) => {
      if (excess === null) demands.current.delete(key);
      else demands.current.set(key, excess);
      decide();
    },
    [decide],
  );
  useLayoutEffect(() => {
    const main = mainRef.current;
    const rail = railRef.current;
    const probe = probeRef.current;
    if (!active || !main || !rail || !probe) return undefined;
    const measure = () => {
      geometry.current = {
        stacked: rail.offsetTop >= main.offsetTop + main.offsetHeight - 1,
        column: main.offsetHeight,
        shared: probe.offsetHeight,
      };
      decide();
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [main, rail, probe]) observer.observe(element);
    return () => observer.disconnect();
  }, [active, mainRef, railRef, probeRef, decide]);
  // The layout it decides in changes with the caller's choice, and with it
  // the margin it decides by.
  useLayoutEffect(decide, [decide, railOpen, foldable]);
  return { foldable, onDemand };
}

// ---- End of the folded rail ----

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
    note: noteIsPrimary ? null : annotationForScene(state, noteObject, liveChatMessage(state)),
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
                composedPrimitive(primary, 'primary')
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
  // A primary that outgrows the column it shares with a rail standing under
  // it takes the stage's height, the rail folded to a strip (stageFold.ts).
  // The caller may open the rail again; that holds for this primary.
  const mainRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const primaryId = content ? (primaryObject(state)?.id ?? null) : null;
  const [openFor, setOpenFor] = useState<string | null>(null);
  const railOpen = primaryId !== null && openFor === primaryId;
  const { foldable, onDemand } = useStageFold(content !== null, railOpen, mainRef, railRef, probeRef);
  const staged = foldable && !railOpen;
  const railNote = calloutPlaced ? null : (content?.note ?? null);
  const noteCut = useStripCut(railRef, staged, railNote);
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
          <div className={`content-grid${staged ? ' content-grid--staged' : ''}`} data-stage={foldable ? (staged ? 'primary' : 'shared') : undefined}>
            <div ref={probeRef} className="content-grid__probe" aria-hidden="true" />
            <MainWithAux ref={mainRef} variant={content.mainVariant} aux={content.aux} onFocus={onFocus} onDemand={onDemand}>
              {content.main}
            </MainWithAux>
            <motion.aside
              ref={railRef}
              className={`content-rail${foldable ? ` content-rail--foldable content-rail--${staged ? 'folded' : 'open'}` : ''}`}
              layout
            >
              {foldable ? (
                <RailHandle
                  open={railOpen}
                  items={foldedItems(state, content, railNote, noteCut)}
                  onToggle={() => setOpenFor(railOpen ? null : primaryId)}
                />
              ) : null}
              {presence}
              <RailDetails
                state={state}
                metrics={content.metrics}
                note={railNote}
                noteObject={calloutPlaced ? undefined : content.noteObject}
                progressList={content.progressList}
                onFocus={onFocus}
                onOpenHistory={onOpenHistory}
                folded={staged}
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
