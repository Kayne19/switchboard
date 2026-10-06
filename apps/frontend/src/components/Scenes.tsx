import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type {
  ChartData,
  ControllerState,
  MessageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { RUNTIME_CONVERSATION_ID } from '../controller/types';
import { noteTarget } from '../app/noteItems';
import { anchoredNote, besideVisuals, buildCompositionModel, cast, nameFields, objectsOfType, primaryObject, VISUAL_TYPES, type SceneKind } from '../app/sceneModel';
import { stageReport, wantsStage, type StageReport } from '../app/stageFold';
import { useLayoutMotion } from '../hooks/useLayoutMotion';
import { StageDemandContext, watchElement, type StageDemandListener } from '../hooks/useStageDemand';
import { AnnotationCard, type NoteTarget } from '../primitives/AnnotationCard';
import { calendarFrame } from '../primitives/CalendarPrimitive';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { chartKind } from '../primitives/chartGeometry';
import { countText } from '../primitives/countText';
import { DamoclesPresence } from '../primitives/DamoclesPresence';
import { LiveChatCard } from '../primitives/LiveChatCard';
import { SpokenLog } from '../primitives/SpokenLog';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { SceneFooter } from '../primitives/SceneFooter';
import { Chevron } from '../primitives/ScrollRim';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { TechFrame, type FrameVariant } from '../primitives/TechFrame';
import { ToolActivity } from '../primitives/ToolActivity';
import { TranscriptToggle } from '../primitives/TranscriptToggle';
import { ChartNotes, chartNoteAnchors, type ChartNote } from './ChartNotes';
import { renderObject } from './renderObject';
import { SurfaceBoundary } from './SurfaceBoundary';

/** A text field an object's data may carry for the scene frame, or undefined
 * when that shape has none. */
function frameText(data: unknown, field: 'subtitle' | 'context'): string | undefined {
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
function RailNote({ note, noteObject, onFocus, onOpenHistory, named, leads = false }: ExplanationProps & { named: NoteTarget; leads?: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {note ? (
        <ObjectMotion key="rail-note" objectId={noteObject?.id ?? 'speech-note'} className={`rail-note${leads ? ' rail-note--leads' : ''}`} layout="position">
          <SurfaceBoundary surfaceId={noteObject?.id ?? 'speech-note'} resetKey={noteObject ?? note}>
            <AnnotationCard
              data={note}
              onFocus={noteObject ? () => onFocus(noteObject.id) : undefined}
              onOpenHistory={noteObject ? undefined : onOpenHistory}
              named={named}
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
              <ProgressPrimitive data={progress.data} slot="rail" />
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
  /** The note is one the charts could not hold, or one about a visual off them: where the column is too short for all it carries, the note leads it, whole, rather than fall under the fold of the metrics. */
  noteLeads?: boolean;
  /** The column's id, for the handle that opens and folds it. */
  id?: string;
}

// Whether the rail's column holds more than it shows, measured only while
// a note may lead it.
function useCrowded(ref: RefObject<HTMLDivElement | null>, watching: boolean): boolean {
  const [crowded, setCrowded] = useState(false);
  useLayoutEffect(() => {
    const column = ref.current;
    if (!watching || !column) {
      setCrowded(false);
      return undefined;
    }
    return watchElement(column, () => setCrowded(column.scrollHeight > column.clientHeight + 1), { children: true });
  }, [ref, watching]);
  return watching && crowded;
}

// The details column beside every content visual: the metrics and any
// progress the main column has no slot for, one stack of instruments read
// the same way, then the live response, the note, and tool activity. It is
// a permanent slot; an empty one renders nothing, and
// the activity panel can linger after its end without the wrapper
// unmounting it first. Its children stand in one order in every state:
// folded to a strip, the stylesheet sets aside all but the note (or the
// live response where there is no note); a note that leads a crowded
// column does so by its order there. Folding or leading moves nothing in or
// out of the page, so nothing is drawn afresh.
function RailDetails({ state, metrics, note, noteObject, progressList, onFocus, onOpenHistory, folded = false, noteLeads = false, id }: RailDetailsProps) {
  const liveMessage = liveChatMessage(state);
  const columnRef = useRef<HTMLDivElement>(null);
  const leads = useCrowded(columnRef, !folded && noteLeads && note !== null);
  // The response and the note stretch into the column's free space, so while
  // either is shown the activity slot stays reserved and a tool starting or
  // clearing never resizes them. Metrics and progress keep their own size at
  // the top and are not moved by a panel below them.
  const reserveActivity = liveMessage !== null || note !== null;
  return (
    <div ref={columnRef} id={id} className={`content-rail__details${folded && note ? ' content-rail__details--noted' : ''}`}>
      {metrics.length > 0 ? <MetricsPrimitive metrics={metrics} slot="rail" /> : null}
      <RailProgress progressList={progressList} onFocus={onFocus} />
      {liveMessage ? <LiveChatCard message={liveMessage} onOpenHistory={onOpenHistory} /> : null}
      <RailNote note={note} noteObject={noteObject} onFocus={onFocus} onOpenHistory={onOpenHistory} named={noteTarget(state.agentObjects, note)} leads={leads} />
      <ToolActivity activity={state.activity} reserveSpace={reserveActivity} />
    </div>
  );
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
  /** The rail's note is one the charts could not hold, or one about a visual off them: in a rail too short for all it carries, it leads. */
  noteLeads?: boolean;
  progressList: Array<SceneObject<ProgressData>>;
  /** The primary chart and the notes on it, by key: a band holds a note while it is one of them. */
  chartNotes?: { chart: string; keys: string[] };
}

// `railNote` is the note a chart has said, through `onRailNote`, it leaves
// out for the rail; the rail shows it while that chart is the primary.
// `band` is the note the shell has moved from the rail to a band under the
// charts, where the rail stands under them (SceneShell).
function trainingContent(
  { state, onFocus, onOpenHistory }: SceneProps,
  railNote: ChartRailNote | null,
  onRailNote: (chartId: string, key: string, away: boolean) => void,
  band: ChartRailNote | null,
  onDemand: StageDemandListener,
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
  // points they name, and of the data the chart draws. Only the one note it
  // cannot hold so, where the rail stands under the charts, takes a band.
  const { byPanel: notesByPanel, offCharts } = chartNotesByPanel(state, charts, primary);
  const primaryNotes = notesByPanel.get(primary.id) ?? [];
  // A note the primary chart left out, held in a band under the charts:
  // the chart no longer places it, and the rail does not carry it.
  const banded = band?.chart === primary.id ? primaryNotes.find((note) => note.key === band.note) : undefined;
  // The rail's one note slot: a note about a visual off the charts, else
  // the note the primary chart leaves out so the rest have clear places.
  const inRail =
    offCharts ??
    (railNote?.chart === primary.id && railNote.note !== banded?.key ? primaryNotes.find((note) => note.key === railNote.note) : undefined);
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
    noteLeads: inRail !== undefined,
    progressList: railProgress,
    // A band is carved from one chart's slot. A compare pair on a portrait
    // stage already scrolls in its row, and a band would push the second
    // chart out of view: its note stays in the rail, leading it.
    chartNotes: charts.length === 1 ? { chart: primary.id, keys: primaryNotes.map((note) => note.key) } : undefined,
    aux: firstProgress && !progress ? [...besideCharts, firstProgress] : besideCharts,
    main: (
      <StageColumn className="content-main training-main">
        <div className={`training-charts${charts.length > 1 ? ' training-charts--compare' : ''}`}>
          <AnimatePresence mode="popLayout" initial={false}>
            {charts.map((chart) => {
              const notes = notesByPanel.get(chart.id) ?? [];
              // Its bar or point stays marked; the card is in the band.
              const onChart = banded ? notes.filter((note) => note.key !== banded.key) : notes;
              // The notes whose leaders run to their points on the chart: not
              // the one in the band, nor the one the chart left for the rail.
              const away = railNote?.chart === chart.id ? railNote.note : undefined;
              const led = onChart.filter((note) => note.key !== away);
              return (
                <ObjectMotion key={chart.id} objectId={chart.id} className="chart-object" data-chart-id={chart.id}>
                  <TechFrame variant="panel" />
                  <ObjectSurface object={chart}>
                    <FocusableSurface onActivate={() => onFocus(chart.id)} ariaLabel={`Expand ${chart.data.title ?? 'chart'}`}>
                      <StageDemandContext.Provider value={chart.id === primary.id ? onDemand : null}>
                        <ChartPrimitive data={chart.data} named={chartNoteAnchors(chart, notes)} led={chartNoteAnchors(chart, led)} />
                      </StageDemandContext.Provider>
                    </FocusableSurface>
                  </ObjectSurface>
                  {onChart.length > 0 ? (
                    <ChartNotes
                      chart={chart}
                      objects={state.agentObjects}
                      notes={onChart}
                      named={chartNoteAnchors(chart, notes)}
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
        <AnimatePresence initial={false}>
          {banded ? (
            <ObjectMotion key="chart-note-band" objectId={banded.object?.id ?? banded.key} className="chart-note-band" data-note={banded.key} layout="position">
              <SurfaceBoundary surfaceId={banded.object?.id ?? banded.key} resetKey={banded.object ?? banded.data}>
                <AnnotationCard
                  data={banded.data}
                  onFocus={banded.object ? () => onFocus(banded.object!.id) : undefined}
                  onOpenHistory={banded.object ? undefined : onOpenHistory}
                  named={noteTarget(state.agentObjects, banded.data)}
                />
              </SurfaceBoundary>
            </ObjectMotion>
          ) : null}
        </AnimatePresence>
        {progress ? (
          <ObjectMotion objectId={progress.id} className="training-progress">
            <ObjectSurface object={progress}>
              <FocusableSurface onActivate={() => onFocus(progress.id)} ariaLabel="Expand progress">
                <ProgressPrimitive data={progress.data} />
              </FocusableSurface>
            </ObjectSurface>
          </ObjectMotion>
        ) : null}
      </StageColumn>
    ),
  };
}

// A diagram, document, code, table, image, calendar, to-do list, inbox,
// timer or forecast fills the main slot, its note in the rail -- unless the
// diagram places the note as its own callout -- and every other visual in
// the aux row under it.
function objectContent({ state, onFocus }: SceneProps, onCalloutChange: (placed: boolean) => void, onDemand: StageDemandListener): SceneContent | null {
  const primary = primaryObject(state);
  const frame = primary ? sceneFrame(primary) : null;
  if (!primary || !frame) return null;
  const noteObject = noteForTarget(objectsOfType<NoteData>(state, 'note'), primary.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  const { outline, ...words } = frame;
  return {
    ...words,
    // What the shell places around the main slot: the aux row under it
    // (every visual beside the primary) and the rail beside it.
    aux: besideVisuals(buildCompositionModel(state)),
    metrics: objectsOfType<MetricData>(state, 'metric'),
    note,
    noteObject,
    progressList: objectsOfType<ProgressData>(state, 'progress'),
    main: (
      <ObjectMotion objectId={primary.id} className={`content-main ${primary.type}-object`}>
        {outline ? <TechFrame variant={outline} /> : null}
        <ObjectSurface object={primary}>
          <FocusableSurface onActivate={() => onFocus(primary.id)} ariaLabel={`Expand ${primary.type}`}>
            <StageDemandContext.Provider value={onDemand}>
              {renderObject(primary, 'primary', { onStage: state.agentObjects, notes: note ? [note] : [], onCalloutChange })}
            </StageDemandContext.Provider>
          </FocusableSurface>
        </ObjectSurface>
      </ObjectMotion>
    ),
  };
}

/** What the scene's frame says about a primary that fills the main slot, and the frame drawn round the slot where its primitive draws none of its own. */
type SceneFrame = Pick<SceneContent, 'title' | 'subtitle' | 'context' | 'footer' | 'caption'> & { outline?: FrameVariant };

// The frame's words for each type that fills the main slot: the agent's
// own where it sent them, else what the object is. The object itself is
// drawn by `renderObject`, as everywhere else.
function sceneFrame(primary: SceneObject): SceneFrame | null {
  switch (primary.type) {
    case 'diagram': {
      const { data } = cast.diagram(primary);
      const sequence = data.mode === 'sequence';
      return {
        title: data.title ?? (sequence ? 'SYSTEM / SEQUENCE' : 'SYSTEM / DIAGRAM'),
        subtitle: data.subtitle ?? (sequence ? 'SEQUENCE / COMPOSED' : 'GRAPH / COMPOSED'),
        context: data.context ?? (sequence ? 'SEQUENCE' : 'SYSTEM MAP'),
        footer: sequence ? 'DISPLAY / SEQUENCE' : 'DISPLAY / SYSTEM MAP',
        caption: sceneCaption(primary, sequence ? 'TRACE / MESSAGE ORDER' : 'TRACE / ACTIVE ROUTE'),
        outline: 'rails',
      };
    }
    case 'document': {
      const { data } = cast.document(primary);
      return {
        title: `DOCUMENT / ${data.kind?.toUpperCase() ?? 'CONTENT'}`,
        subtitle: 'CONTENT / ORIGINAL',
        context: data.context ?? 'DOCUMENT',
        footer: 'CONTENT / ORIGINAL EMAIL',
        caption: sceneCaption(primary, 'CHROME / SWITCHBOARD'),
      };
    }
    case 'code': {
      const { data } = cast.code(primary);
      return {
        title: data.title ?? 'SOURCE / LIVE',
        subtitle: data.file ?? 'SOURCE',
        context: data.context ?? 'SOURCE',
        footer: 'FRAME / INTERRUPTED RAILS',
        caption: sceneCaption(primary, 'DISPLAY / SOURCE'),
      };
    }
    case 'table': {
      const { data } = cast.table(primary);
      return {
        title: data.title ?? 'DATA / TABLE',
        subtitle: data.subtitle ?? 'ROWS / COLUMNS',
        context: data.context ?? 'TABLE',
        footer: 'FRAME / INTERRUPTED RAILS',
        caption: sceneCaption(primary, 'DISPLAY / TABLE'),
      };
    }
    case 'image': {
      // The figure's own words head the scene; its alt text stands in for
      // a title it was not given.
      const { data } = cast.image(primary);
      return {
        title: data.title ?? data.alt,
        subtitle: data.subtitle ?? `IMAGE / ${data.format.toUpperCase()}`,
        context: data.context ?? 'FIGURE',
        footer: 'DISPLAY / FIGURE',
        caption: sceneCaption(primary, `FIGURE / ${data.format.toUpperCase()}`),
        outline: 'panel',
      };
    }
    case 'calendar': {
      const { data } = cast.calendar(primary);
      return {
        ...calendarFrame(data),
        footer: 'DISPLAY / CALENDAR',
        caption: sceneCaption(primary, `CALENDAR / ${data.view.toUpperCase()}`),
        outline: 'panel',
      };
    }
    case 'tasks': {
      // A to-do list heads the scene with its own words, else its kind: the
      // list's meta line and its sections' heads say what it holds.
      const { data } = cast.tasks(primary);
      return {
        title: data.title ?? 'TASKS / TO DO',
        subtitle: data.subtitle ?? 'CHECKLIST',
        context: data.context ?? 'TASKS',
        footer: 'DISPLAY / TASKS',
        caption: sceneCaption(primary, 'TASKS / TO DO'),
        outline: 'panel',
      };
    }
    case 'inbox': {
      const { data } = cast.inbox(primary);
      return {
        title: data.title ?? 'INBOX / MESSAGES',
        subtitle: data.subtitle ?? 'MESSAGES / AS SENT',
        context: data.context ?? 'INBOX',
        footer: 'DISPLAY / INBOX',
        caption: sceneCaption(primary, 'INBOX / AS SENT'),
        outline: 'panel',
      };
    }
    case 'timer': {
      const { data } = cast.timer(primary);
      const paused = data.timers.filter((timer) => timer.state === 'paused').length;
      return {
        title: data.title ?? (data.timers.length === 1 ? data.timers[0].label : 'TIMERS'),
        subtitle: data.subtitle ?? [countText(data.timers.length, ['TIMER', 'TIMERS']), paused > 0 ? `${paused} PAUSED` : null].filter(Boolean).join(' / '),
        context: data.context ?? 'TIMERS',
        footer: 'DISPLAY / TIMERS',
        caption: sceneCaption(primary, 'TIMERS / PAGE CLOCK'),
        outline: 'panel',
      };
    }
    case 'weather': {
      const { data } = cast.weather(primary);
      return {
        title: data.title ?? `WEATHER / ${data.location}`,
        subtitle: data.subtitle ?? ['NOW', data.hourly?.length ? `${data.hourly.length} H` : null, data.daily?.length ? `${data.daily.length} DAYS` : null].filter(Boolean).join(' + '),
        context: data.context ?? 'FORECAST',
        footer: 'DISPLAY / FORECAST',
        caption: sceneCaption(primary, `FORECAST / DEGREES ${data.units}`),
        outline: 'panel',
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
// what the rail's note names in it (`drawn`): an item, a node, an actor.
function AuxRow({
  objects,
  onStage,
  onFocus,
  drawn,
}: {
  objects: SceneObject[];
  /** Every object on stage, by id. */
  onStage: ControllerState['agentObjects'];
  onFocus: (id: string | null) => void;
  /** The note the rail draws: each cell marks what it names in its object. */
  drawn: NoteData | null;
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
              {renderObject(object, 'aux', { onStage, notes: drawn ? [drawn] : [] })}
            </FocusableSurface>
          </ObjectSurface>
        </ObjectMotion>
      ))}
    </div>
  );
}

// A column of the stage that moves and resizes with its layout: the main
// column, and a scene's own column in its main slot (`useLayoutMotion`).
function StageColumn({ className, ref, children }: { className: string; ref?: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const layoutMotion = useLayoutMotion({ layout: true });
  return (
    <motion.div ref={ref} className={className} {...layoutMotion}>
      {children}
    </motion.div>
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
  onStage,
  onFocus,
  drawn,
  ref,
  children,
}: {
  variant?: string;
  aux: SceneObject[];
  onStage: ControllerState['agentObjects'];
  onFocus: (id: string | null) => void;
  drawn: NoteData | null;
  ref?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <StageColumn ref={ref} className={`content-main composed-main${variant ? ` ${variant}` : ''}`}>
      {children}
      {aux.length > 0 ? <AuxRow objects={aux} onStage={onStage} onFocus={onFocus} drawn={drawn} /> : null}
    </StageColumn>
  );
}

// ---- The rail folded under a primary that takes the stage's height ----

// What a folded rail keeps behind its handle, in the handle's words: the
// strip itself shows the note (or the live response) and Damocles, and the
// rest of a note held to its first lines.
function foldedItems(state: ControllerState, content: SceneContent, note: NoteData | null, cut: boolean): string[] {
  const items: string[] = [];
  if (cut) items.push(note ? 'NOTE' : 'LIVE');
  if (content.metrics.length > 0) items.push(countText(content.metrics.length, ['METRIC', 'METRICS'], { pad: true }));
  if (content.progressList.length > 0) items.push('PROGRESS');
  if (note && liveChatMessage(state)) items.push('LIVE');
  if (state.activity) items.push('ACTIVITY');
  return items;
}

// Whether the folded strip holds its text -- the note, or the live response
// as it streams -- to fewer lines than it has.
function useStripCut(railRef: RefObject<HTMLElement | null>, folded: boolean): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const details = folded ? railRef.current?.querySelector<HTMLElement>('.content-rail__details') : null;
    if (!details) {
      setCut(false);
      return undefined;
    }
    const shown = () =>
      [...details.querySelectorAll<HTMLElement>('.annotation-card__text, .live-chat-card__text')].find((text) => text.offsetParent !== null);
    return watchElement(
      details,
      () => {
        const text = shown();
        setCut(text !== undefined && text.scrollHeight > text.clientHeight + 1);
      },
      { changes: true },
    );
  }, [railRef, folded]);
  return folded && cut;
}

// The rail's handle, over it whenever its primary can take the stage: on
// the folded strip it names what the rail keeps folded, and opens it; on
// the open rail it folds it again. A strip that keeps nothing folded has a
// rule there and no control. Its name holds the words it shows, so a
// caller who says what they see reaches it.
function RailHandle({ open, items, controls, onToggle }: { open: boolean; items: string[]; controls: string; onToggle: () => void }) {
  if (!open && items.length === 0) {
    return (
      <div className="rail-handle rail-handle--bare" aria-hidden="true">
        <span className="rail-handle__rule" />
      </div>
    );
  }
  const shown = open ? 'FOLD' : items.join(' / ');
  return (
    <button
      type="button"
      className={`rail-handle rail-handle--${open ? 'open' : 'folded'}`}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `${shown} the rail` : `${shown}: open the rail`}
      onClick={onToggle}
    >
      <span className="rail-handle__rule" aria-hidden="true" />
      <span className="rail-handle__label tech micro">{shown}</span>
      <Chevron className="rail-handle__chevron" />
    </button>
  );
}

// Whether the primary takes the stage's height (stageFold.ts), and, where
// a scene asks (`watchStacked`), whether the rail stands under the main
// column. What it hears from the primary and measures of the column is
// kept out of render, and a decision that does not change renders nothing:
// a scene that never folds is drawn exactly as it was. The columns are
// read in layout pixels: a box in a shared-layout animation is scaled on
// screen, never in its offsets. The shared column is the probe, sized by
// the same rule as that grid row.
//
// Each report is kept with the layout it was measured in (the one the
// primary shares with the rail, or the stage), so a content measured on the
// stage is weighed against the viewport it had in the shared layout, not
// against a model of the frame round it. Opening the rail changes neither
// the reports nor the decision: the handle stays where it is.
function useStageFold(
  subject: string | null,
  railOpen: boolean,
  watchStacked: boolean,
  mainRef: RefObject<HTMLDivElement | null>,
  railRef: RefObject<HTMLElement | null>,
  probeRef: RefObject<HTMLDivElement | null>,
): { foldable: boolean; staged: boolean; stacked: boolean; onDemand: StageDemandListener } {
  const [foldable, setFoldable] = useState(false);
  const [stacked, setStacked] = useState(false);
  const staged = foldable && !railOpen;
  const reports = useRef(new Map<string, StageReport>());
  // What the page shows now, kept as it commits: a report is measured in
  // the layout on screen, and a decision weighs what it decided last.
  const shown = useRef({ foldable, staged, watchStacked });
  useLayoutEffect(() => {
    shown.current = { foldable, staged, watchStacked };
  });
  const measure = useCallback(() => {
    const main = mainRef.current;
    const rail = railRef.current;
    const column = main?.offsetHeight ?? 0;
    return {
      stacked: main !== null && rail !== null && column > 0 && rail.offsetTop >= main.offsetTop + column - 1,
      shared: probeRef.current?.offsetHeight ?? 0,
    };
  }, [mainRef, railRef, probeRef]);
  const decide = useCallback(() => {
    const now = measure();
    setFoldable(wantsStage(now.stacked, [...reports.current.values()], shown.current.foldable, now.shared));
    setStacked(shown.current.watchStacked && now.stacked);
  }, [measure]);
  const onDemand = useCallback<StageDemandListener>(
    (key, said) => {
      if (said === null) reports.current.delete(key);
      else {
        const now = measure();
        reports.current.set(key, stageReport(said, now.stacked && !shown.current.staged, now.shared, reports.current.get(key)));
      }
      decide();
    },
    [measure, decide],
  );
  const active = subject !== null;
  useLayoutEffect(() => {
    const boxes = [mainRef.current, railRef.current, probeRef.current];
    if (!active || boxes.some((box) => !box)) return undefined;
    decide();
    const observer = new ResizeObserver(decide);
    for (const box of boxes) observer.observe(box!);
    return () => observer.disconnect();
  }, [active, mainRef, railRef, probeRef, decide]);
  useLayoutEffect(decide, [decide, watchStacked]);
  // A new primary is first measured in the layout it would share with the
  // rail: its content has said nothing there yet (a primitive kept from the
  // last one speaks for content that is gone), so the stage's height is not
  // its until it does.
  const shownSubject = useRef(subject);
  useLayoutEffect(() => {
    if (shownSubject.current === subject) return;
    shownSubject.current = subject;
    reports.current.clear();
    shown.current = { ...shown.current, foldable: false };
    setFoldable(false);
  }, [subject]);
  return { foldable, staged, stacked, onDemand };
}


// ---- End of the folded rail ----

// ---- End of the aux row ----

// Any mix of objects: the primary, or a cluster of primary metrics, over an
// aux row of everything the rail does not carry.
function composedContent({ state, onFocus }: SceneProps, onDemand: StageDemandListener): SceneContent | null {
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
    // Named by the same fields, in the same order, as the agent's view (`nameFields`).
    title: nameFields(primary.data)[0] ?? 'COMPOSED WORKSPACE',
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
                slot="primary"
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
                  slot="primary"
                  onFocus={onFocus}
                />
              ) : (
                // A progress or a note: sceneKind gives every visual primary a scene of its own.
                <StageDemandContext.Provider value={onDemand}>{renderObject(primary, 'primary', { onStage: state.agentObjects, notes: note ? [note] : [] })}</StageDemandContext.Provider>
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
  chartBand: ChartRailNote | null,
  onDemand: StageDemandListener,
): SceneContent | null {
  switch (props.kind) {
    case 'idle':
    case 'conversation':
      return null;
    case 'training':
      return trainingContent(props, chartRailNote, onChartRailNote, chartBand, onDemand);
    case 'composed':
      return composedContent(props, onDemand);
    default:
      return objectContent(props, onCalloutChange, onDemand);
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
  // Where the rail stands under the charts, the note the primary chart
  // leaves out is drawn in a band under them, by what it is about, not in
  // the rail under its metrics. It stays there while it is on that chart:
  // the band takes its height from the charts, and a chart laid out again
  // in less room, or for another note, must not take the note back and
  // hand it out again, the band coming and going under it.
  const [chartBand, setChartBand] = useState<ChartRailNote | null>(null);
  // What the primary says it lacks reaches the fold (useStageFold) through
  // a listener made before the scene is, since the scene draws the primary.
  const foldListener = useRef<StageDemandListener | null>(null);
  const onDemand = useCallback<StageDemandListener>((key, said) => foldListener.current?.(key, said), []);
  const content = sceneContent(props, setCalloutPlaced, chartRailNote, onChartRailNote, chartBand, onDemand);
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
  const { foldable, staged, stacked, onDemand: foldOnDemand } = useStageFold(primaryId, railOpen, content?.chartNotes !== undefined, mainRef, railRef, probeRef);
  useLayoutEffect(() => {
    foldListener.current = foldOnDemand;
  }, [foldOnDemand]);
  const banding = stacked ? content?.chartNotes : undefined;
  const bandHeld = chartBand !== null && banding?.chart === chartBand.chart && banding.keys.includes(chartBand.note);
  useLayoutEffect(() => {
    if (chartBand) {
      if (!bandHeld) setChartBand(null);
      return;
    }
    if (banding && chartRailNote?.chart === banding.chart) setChartBand(chartRailNote);
  }, [banding, bandHeld, chartBand, chartRailNote]);
  const railNote = calloutPlaced ? null : (content?.note ?? null);
  const stripCut = useStripCut(railRef, staged);
  const detailsId = useId();
  const railMotion = useLayoutMotion({ layout: true });
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
      className={`scene scene--${layout}${content ? ` scene--${kind}` : ''}${staged ? ' scene--staged' : ''}`}
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
            <MainWithAux ref={mainRef} variant={content.mainVariant} aux={content.aux} onStage={state.agentObjects} onFocus={onFocus} drawn={calloutPlaced ? null : content.note}>
              {content.main}
            </MainWithAux>
            <motion.aside
              ref={railRef}
              className={`content-rail${foldable ? ` content-rail--foldable content-rail--${staged ? 'folded' : 'open'}` : ''}`}
              {...railMotion}
            >
              {foldable ? (
                <RailHandle
                  open={railOpen}
                  items={foldedItems(state, content, railNote, stripCut)}
                  controls={detailsId}
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
                noteLeads={content.noteLeads}
                id={detailsId}
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
