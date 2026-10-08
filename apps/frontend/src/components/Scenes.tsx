import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { flushSync } from 'react-dom';
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
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
import { noteTarget, railNoteTarget } from '../app/noteItems';
import { anchoredNote, besideVisuals, buildCompositionModel, cast, nameFields, objectsOfType, primaryObject, VISUAL_TYPES, type SceneKind } from '../app/sceneModel';
import { useLayoutMotion } from '../hooks/useLayoutMotion';
import { watchElement } from '../hooks/watchElement';
import { AnnotationCard, type NoteTarget } from '../primitives/AnnotationCard';
import { calendarFrame } from '../primitives/CalendarPrimitive';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { chartKind } from '../primitives/chartGeometry';
import { NOTES_PLACED_IN_FULL } from '../primitives/notePlacement';
import { countText } from '../primitives/countText';
import { DamoclesPresence } from '../primitives/DamoclesPresence';
import { ListViewport, continuesPast, fadeDepth } from '../primitives/ListViewport';
import { LiveChatCard } from '../primitives/LiveChatCard';
import { SpokenLog } from '../primitives/SpokenLog';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { SceneFooter } from '../primitives/SceneFooter';
import { ScrollRim } from '../primitives/ScrollRim';
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
  /** The focus layer is open over the scene: the scene is inert behind it (FocusLayer `useModalFocus`). */
  behindFocus?: boolean;
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
function RailNote({ note, noteObject, onFocus, onOpenHistory, named, leads = false, stacked = false }: ExplanationProps & { named: NoteTarget; leads?: boolean; stacked?: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {note ? (
        <ObjectMotion key="rail-note" objectId={noteObject?.id ?? 'speech-note'} className={`rail-note${leads ? ' rail-note--leads' : ''}${stacked ? ' rail-note--stacked' : ''}`} layout="position">
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

// The notes the rail carries after its note: every note on stage is shown
// somewhere, so a second note about the primary, one about another object
// or one past what a chart holds is not dropped (pr/issues.md, "The rail
// shows one note"). Each reads whole, at its own height, after the first,
// in the order the agent showed them; the column scrolls where they do not
// all fit. They lead with the first where it leads.
function RailMoreNotes({ notes, drawn, onFocus, objects, leads }: { notes: Array<SceneObject<NoteData>>; drawn: NoteData[]; onFocus: (id: string | null) => void; objects: Readonly<Record<string, SceneObject>>; leads: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {notes.map((object) => (
        <ObjectMotion key={object.id} objectId={object.id} className={`rail-note rail-note--stacked${leads ? ' rail-note--leads' : ''}`} layout="position">
          <SurfaceBoundary surfaceId={object.id} resetKey={object}>
            <AnnotationCard data={object.data} onFocus={() => onFocus(object.id)} named={railNoteTarget(objects, drawn, object.data)} />
          </SurfaceBoundary>
        </ObjectMotion>
      ))}
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
  /** The notes the rail carries after `note` (`RailMoreNotes`). */
  moreNotes?: Array<SceneObject<NoteData>>;
  /** Every note the page draws about the scene's objects, in order -- the rail's, and its note where a diagram carries it as a callout instead: an object marks what the first about it names, and only that card carries the badge. */
  pageNotes?: NoteData[];
  progressList: Array<SceneObject<ProgressData>>;
  onFocus: (id: string | null) => void;
  onOpenHistory?: () => void;
  /** The note is one the charts could not hold, or one about a visual off them: where the column beside the main one is too short for all it carries, the note leads it, whole, rather than fall below the metrics, out of view (under the main column every note does so). */
  noteLeads?: boolean;
  /** The rail stands under the main column (useRailUnder): its note reads whole there (useRailFit). */
  under?: boolean;
  /** Hears how tall the note reads whole in, CSS pixels, while the rail stands under the column; `null` with no note there. */
  onFloor?: (height: number | null) => void;
  /** The floor the grid gives the rail now (what `onFloor` last said, applied). */
  floor?: number | null;
}

// Whether the rail's column holds more than it shows, measured only while
// a note may lead it beside the column (a chart's handed-over note); under
// the column every note may lead, by useRailFit's measure.
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

interface RailFit {
  /** The column cannot hold all it carries: the note leads it. */
  leads: boolean;
  /** The column's foot has no room for the activity panel whole: it is set aside. */
  away: boolean;
  /** The column continues past its top or its foot: that edge fades (ScrollRim), as a scroller's does, `fade` px deep. */
  above: boolean;
  below: boolean;
  fade: number;
}
const FITS: RailFit = { leads: false, away: false, above: false, below: false, fade: 0 };
const sameFit = (a: RailFit, b: RailFit) => a.leads === b.leads && a.away === b.away && a.above === b.above && a.below === b.below && a.fade === b.fade;

// Under the main column (a portrait stage) the rail is Damocles beside the
// note, and the note reads whole there, as Kayne approved the portrait
// goldens: it keeps its own height (the stylesheet), and the column says
// how tall that is (`onFloor`), so the rail grows to hold it and the main
// column gives up as much, keeping the larger share (the grid). What else
// the rail carries does not size it: where it does not all fit, the note
// leads, whole, the rest after it in the column's scroll; and the activity
// panel stands at the column's foot only where it fits there whole -- where
// it does not, Damocles's caption, which names the tool at work wherever
// the rail stands, is what the caller sees of it. An edge the column
// continues past fades as a scroller's edge does, so a part cut there
// reads as the next one coming, not as broken.
//
// A part counts at its own height and margins (a live response, which
// grows into the column's free space, at its least), never at what these
// decide. Yet they feed one another -- the floor sets the column's height,
// the panel set aside leaves its flow -- so the layout takes a second
// measure; what the observers measure is committed before the frame is
// painted, so no frame shows a rail half decided.
function useRailFit(ref: RefObject<HTMLDivElement | null>, under: boolean, onFloor: (height: number | null) => void, floor: number | null): RailFit {
  const [fit, setFit] = useState(FITS);
  const remeasure = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const column = ref.current;
    if (!under || !column) {
      setFit(FITS);
      onFloor(null);
      return undefined;
    }
    const commit = (next: RailFit) => setFit((current) => (sameFit(current, next) ? current : next));
    // The edges from the column's flow as decided (what its class changes do
    // to it are not observed), and where its scroll stands.
    let decided: Pick<RailFit, 'leads' | 'away'> = FITS;
    let flow = 0;
    const edges = (): RailFit => {
      const goes = continuesPast(column.scrollTop, column.clientHeight, flow);
      return { ...decided, above: goes.top, below: goes.bottom, fade: fadeDepth(column.clientHeight) };
    };
    const measure = () => {
      const children = Array.from(column.children) as HTMLElement[];
      const slot = children.find((child) => child.classList.contains('tool-activity-slot'));
      const parts = children.filter((child) => child !== slot && child.offsetHeight > 0);
      const note = parts.find((child) => child.classList.contains('rail-note'));
      const gap = parseFloat(getComputedStyle(column).rowGap) || 0;
      const least = (part: HTMLElement) => {
        const style = getComputedStyle(part);
        const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        return margins + ((parseFloat(style.flexGrow) || 0) > 0 ? parseFloat(style.minHeight) || 0 : parseFloat(style.height) || part.offsetHeight);
      };
      const content = parts.reduce((sum, part) => sum + least(part), 0) + gap * Math.max(0, parts.length - 1);
      const panel = slot && slot.offsetHeight > 0 ? (parts.length > 0 ? gap : 0) + slot.offsetHeight : 0;
      const room = column.clientHeight;
      onFloor(note ? Math.ceil(least(note)) : null);
      decided = {
        leads: note !== undefined && parts.length > 1 && content > room + 1,
        away: panel > 0 && content + panel > room + 1,
      };
      flow = content + (decided.away ? 0 : panel);
      commit(edges());
    };
    // The first measure is the layout effect's own; the observers' are
    // committed at once (flushSync), before the frame they report is painted.
    let observing = false;
    const stop = watchElement(column, () => (observing ? flushSync(measure) : measure()), { children: true, changes: true });
    observing = true;
    remeasure.current = measure;
    // A scroll moves only the edges, read once a frame.
    let frame = 0;
    const scrolled = () => {
      if (frame === 0) frame = requestAnimationFrame(() => {
        frame = 0;
        commit(edges());
      });
    };
    column.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      stop();
      cancelAnimationFrame(frame);
      column.removeEventListener('scroll', scrolled);
      remeasure.current = () => {};
    };
  }, [ref, under, onFloor]);
  // The floor it said, once the grid has it: measured again in the same
  // commit, so the first frame is drawn in the rail the floor makes.
  useLayoutEffect(() => remeasure.current(), [floor]);
  return under ? fit : FITS;
}

// Beside the main column, where the rail carries more than one note, the
// column scrolls where they do not all fit, and an edge it continues past
// fades as a scroller's edge does (under the column, useRailFit says so).
function useColumnEdges(ref: RefObject<HTMLDivElement | null>, watching: boolean): Pick<RailFit, 'above' | 'below' | 'fade'> {
  const [edges, setEdges] = useState({ above: false, below: false, fade: 0 });
  useLayoutEffect(() => {
    const column = ref.current;
    if (!watching || !column) return undefined;
    const measure = () => {
      const next = { above: column.scrollTop > 1, below: column.scrollTop + column.clientHeight < column.scrollHeight - 1, fade: fadeDepth(column.clientHeight) };
      setEdges((current) => (current.above === next.above && current.below === next.below && current.fade === next.fade ? current : next));
    };
    measure();
    const stop = watchElement(column, measure, { children: true, changes: true });
    let frame = 0;
    const scrolled = () => {
      if (frame === 0) frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    column.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      stop();
      cancelAnimationFrame(frame);
      column.removeEventListener('scroll', scrolled);
    };
  }, [ref, watching]);
  return watching ? edges : FITS;
}

const noFloor = () => {};
const NO_NOTES: Array<SceneObject<NoteData>> = [];

// The details column beside every content visual: the metrics and any
// progress the main column has no slot for, one stack of instruments read
// the same way, then the live response, the note, and tool activity. It is
// a permanent slot; an empty one renders nothing, and
// the activity panel can linger after its end without the wrapper
// unmounting it first. Its children stand in one order in every state; a
// note that leads a crowded column does so by its order there, so leading
// moves nothing in or out of the page, and nothing is drawn afresh.
function RailDetails({ state, metrics, note, noteObject, moreNotes = NO_NOTES, pageNotes, progressList, onFocus, onOpenHistory, noteLeads = false, under = false, onFloor = noFloor, floor = null }: RailDetailsProps) {
  const liveMessage = liveChatMessage(state);
  const columnRef = useRef<HTMLDivElement>(null);
  const crowded = useCrowded(columnRef, !under && noteLeads && (note !== null || moreNotes.length > 0));
  const fit = useRailFit(columnRef, under, onFloor, floor);
  const stacked = moreNotes.length > 0;
  const beside = useColumnEdges(columnRef, !under && stacked);
  const edges = under ? fit : beside;
  // The response and the note stretch into the column's free space, so while
  // either is shown the activity slot stays reserved and a tool starting or
  // clearing never resizes them. Metrics and progress keep their own size at
  // the top and are not moved by a panel below them.
  const reserveActivity = liveMessage !== null || note !== null || moreNotes.length > 0;
  const leads = under ? fit.leads : crowded;
  // Every note the page draws, in order: an object marks what the first
  // about it names, and only that card carries the badge.
  const drawn = pageNotes ?? [...(note ? [note] : []), ...moreNotes.map((object) => object.data)];
  return (
    <>
      <div ref={columnRef} className="content-rail__details">
        {metrics.length > 0 ? <MetricsPrimitive metrics={metrics} slot="rail" /> : null}
        <RailProgress progressList={progressList} onFocus={onFocus} />
        {liveMessage ? <LiveChatCard message={liveMessage} onOpenHistory={onOpenHistory} /> : null}
        <RailNote note={note} noteObject={noteObject} onFocus={onFocus} onOpenHistory={onOpenHistory} named={railNoteTarget(state.agentObjects, drawn, note)} leads={leads} stacked={stacked} />
        <RailMoreNotes notes={moreNotes} drawn={drawn} onFocus={onFocus} objects={state.agentObjects} leads={leads} />
        <ToolActivity activity={state.activity} reserveSpace={reserveActivity} away={fit.away} />
      </div>
      {/* The column's edges as every scroller draws them: a fade, with no tag (what lies past is the rail's own). */}
      {edges.above ? <ScrollRim side="top" fade={edges.fade} /> : null}
      {edges.below ? <ScrollRim side="bottom" fade={edges.fade} /> : null}
    </>
  );
}

// Which chart panel each note is shown on: the chart it names, a compare
// chart's included, and otherwise the primary. Every note is shown -- a
// second note on the chart is annotated beside the first, not dropped --
// and with no note object on stage, a spoken explanation stands in on the
// primary. A note that names a visual on stage that is not a chart (one in
// the aux row, say) is about that visual, not a chart: it is left for the
// rail, as many as there are.
function chartNotesByPanel(
  state: ControllerState,
  charts: Array<SceneObject<ChartData>>,
  primary: SceneObject<ChartData>,
): { byPanel: Map<string, ChartNote[]>; offCharts: ChartNote[] } {
  const byPanel = new Map<string, ChartNote[]>();
  const add = (chartId: string, note: ChartNote) => byPanel.set(chartId, [...(byPanel.get(chartId) ?? []), note]);
  const offCharts: ChartNote[] = [];
  const noteObjects = objectsOfType<NoteData>(state, 'note');
  for (const object of noteObjects) {
    const targetId = object.data.anchor?.target;
    const named = targetId ? state.agentObjects[targetId] : undefined;
    if (named && named.type !== 'chart' && named.id !== object.id) {
      offCharts.push({ key: object.id, data: object.data, object });
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
  /** The notes the rail carries after `note`, in the order shown: none is dropped. */
  moreNotes?: Array<SceneObject<NoteData>>;
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
  // A chart lays at most `NOTES_PLACED_IN_FULL` notes over itself, the
  // first it was shown, each placed clear of the others and of its data;
  // the rest are read in the rail, where a card has room, rather than over
  // the data or one another (pr/issues.md, "where notes past five go").
  // The chart still marks the points they name.
  const laidOn = (chart: SceneObject<ChartData>) => (notesByPanel.get(chart.id) ?? []).slice(0, NOTES_PLACED_IN_FULL);
  const pastLaid = charts.flatMap((chart) => (notesByPanel.get(chart.id) ?? []).slice(NOTES_PLACED_IN_FULL));
  const primaryNotes = laidOn(primary);
  // A note the primary chart left out, held in a band under the charts:
  // the chart no longer places it, and the rail does not carry it.
  const banded = band?.chart === primary.id ? primaryNotes.find((note) => note.key === band.note) : undefined;
  // The rail's notes: those about a visual off the charts, the note the
  // primary chart leaves out so the rest have clear places, and the notes
  // past those a chart lays over itself, in that order.
  const handedOver = railNote?.chart === primary.id && railNote.note !== banded?.key ? primaryNotes.find((note) => note.key === railNote.note) : undefined;
  const inRail = [...offCharts, ...(handedOver ? [handedOver] : []), ...pastLaid];
  const [railLead, ...railMore] = inRail;
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
    // The notes sit on the charts here; the rail carries the one the
    // primary leaves out, those about a visual that is not a chart, and
    // those past what a chart lays over itself.
    note: railLead?.data ?? null,
    noteObject: railLead?.object,
    moreNotes: railMore.flatMap((note) => (note.object ? [note.object] : [])),
    noteLeads: railLead !== undefined,
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
              // Every note about the chart: the chart marks each one's point.
              const notes = notesByPanel.get(chart.id) ?? [];
              const laid = laidOn(chart);
              // Its bar or point stays marked; the card is in the band.
              const onChart = banded ? laid.filter((note) => note.key !== banded.key) : laid;
              // The notes whose leaders run to their points on the chart: not
              // the one in the band, nor the one the chart left for the rail.
              const away = railNote?.chart === chart.id ? railNote.note : undefined;
              const led = onChart.filter((note) => note.key !== away);
              return (
                <ObjectMotion key={chart.id} objectId={chart.id} className="chart-object" data-chart-id={chart.id}>
                  <TechFrame variant="panel" />
                  <ObjectSurface object={chart}>
                    <FocusableSurface onActivate={() => onFocus(chart.id)} ariaLabel={`Expand ${chart.data.title ?? 'chart'}`}>
                      <ChartPrimitive data={chart.data} named={chartNoteAnchors(chart, notes)} led={chartNoteAnchors(chart, led)} />
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
                      onRailNote={chart.id === primary.id ? onRailNote : undefined}
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
function objectContent({ state, onFocus }: SceneProps, onCalloutChange: (placed: boolean) => void): SceneContent | null {
  const primary = primaryObject(state);
  const frame = primary ? sceneFrame(primary) : null;
  if (!primary || !frame) return null;
  const noteObjects = objectsOfType<NoteData>(state, 'note');
  const noteObject = noteForTarget(noteObjects, primary.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  // The other notes on stage follow it in the rail: the page shows them all.
  const moreNotes = noteObjects.filter((object) => object.id !== noteObject?.id);
  const { outline, ...words } = frame;
  return {
    ...words,
    // What the shell places around the main slot: the aux row under it
    // (every visual beside the primary) and the rail beside it.
    aux: besideVisuals(buildCompositionModel(state)),
    metrics: objectsOfType<MetricData>(state, 'metric'),
    note,
    noteObject,
    moreNotes,
    progressList: objectsOfType<ProgressData>(state, 'progress'),
    main: (
      <ObjectMotion objectId={primary.id} className={`content-main ${primary.type}-object`}>
        {outline ? <TechFrame variant={outline} /> : null}
        <ObjectSurface object={primary}>
          <FocusableSurface onActivate={() => onFocus(primary.id)} ariaLabel={`Expand ${primary.type}`}>
            {renderObject(primary, 'primary', { onStage: state.agentObjects, notes: [...(note ? [note] : []), ...moreNotes.map((object) => object.data)], onCalloutChange })}
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
// what the rail's notes name in it (`drawn`): an item, a node, an actor.
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
  /** The notes the page draws: each cell marks what the first about its object names. */
  drawn: NoteData[];
}) {
  // A row with no room for every cell scrolls under the rim every scroller
  // draws, counting the cells wholly past each edge (ListViewport); it opens
  // at its top, whatever its cells lead with.
  return (
    <ListViewport lead={null} className="composed-aux-viewport" scrollClassName="composed-aux" label="More on stage">
      {objects.map((object) => (
        <ObjectMotion
          key={object.id}
          objectId={object.id}
          className={`composed-aux-object composed-aux-object--${object.type}${VISUAL_TYPES.has(object.type) ? ' composed-aux-object--visual' : ''}`}
        >
          <TechFrame variant="panel" />
          <ObjectSurface object={object}>
            <FocusableSurface onActivate={() => onFocus(object.id)} ariaLabel={`Expand ${object.type}`}>
              {renderObject(object, 'aux', { onStage, notes: drawn })}
            </FocusableSurface>
          </ObjectSurface>
        </ObjectMotion>
      ))}
    </ListViewport>
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
  drawn: NoteData[];
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

// Whether the rail stands under the main column (a portrait stage) rather
// than beside it, read from where the two boxes lie, not from a media query.
// Where it does, the rail's note reads whole (useRailFit), and the note a
// single chart cannot hold lies in a band under it. A scene whose rail
// stays beside its column re-renders nothing for it.
function useRailUnder(active: boolean, mainRef: RefObject<HTMLDivElement | null>, railRef: RefObject<HTMLElement | null>): boolean {
  const [under, setUnder] = useState(false);
  useLayoutEffect(() => {
    const boxes = [mainRef.current, railRef.current];
    if (!active || boxes.some((box) => !box)) {
      setUnder(false);
      return undefined;
    }
    const measure = () => {
      const main = mainRef.current;
      const rail = railRef.current;
      setUnder(main !== null && rail !== null && main.offsetHeight > 0 && rail.offsetTop >= main.offsetTop + main.offsetHeight - 1);
    };
    measure();
    // Committed before the resized frame is painted, as the rail it decides is.
    const observer = new ResizeObserver(() => flushSync(measure));
    for (const box of boxes) observer.observe(box!);
    return () => observer.disconnect();
  }, [active, mainRef, railRef]);
  return active && under;
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
  // The other notes, neither the primary nor drawn in the aux row, follow
  // the rail's note: the page shows them all.
  const moreNotes = noteObjects.filter((object) => object.id !== noteObject?.id && object.id !== primary.id && !auxObjects.some((aux) => aux.id === object.id));

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
    moreNotes,
    progressList: [],
    aux: auxObjects,
    mainVariant: isMetricPrimary ? 'composed-main--metric-primary' : undefined,
    main: (
      <ObjectMotion
        // The object's identity, shared with its focus as every object's is
        // (ObjectMotion's switchboard-object-<id>); a cluster is named by its
        // own id, so focusing one of its metrics grows from nothing in it.
        objectId={primaryMetrics.length > 1 ? 'primary-metric-cluster' : primary.id}
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
                renderObject(primary, 'primary', { onStage: state.agentObjects, notes: [...(note ? [note] : []), ...moreNotes.map((object) => object.data)] })
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
): SceneContent | null {
  switch (props.kind) {
    case 'idle':
    case 'conversation':
      return null;
    case 'training':
      return trainingContent(props, chartRailNote, onChartRailNote, chartBand);
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
  const { kind, state, onToggleListening, onFocus, onOpenHistory, setTranscriptOpen, behindFocus = false } = props;
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
  const content = sceneContent(props, setCalloutPlaced, chartRailNote, onChartRailNote, chartBand);
  const layout = content ? 'content' : kind === 'conversation' ? 'conversation' : 'idle';
  const mainRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const under = useRailUnder(content !== null, mainRef, railRef);
  // How tall the rail's note reads whole in, while the rail stands under the column (RailDetails).
  const [railFloor, setRailFloor] = useState<number | null>(null);
  const banding = under ? content?.chartNotes : undefined;
  const bandHeld = chartBand !== null && banding?.chart === chartBand.chart && banding.keys.includes(chartBand.note);
  useLayoutEffect(() => {
    if (chartBand) {
      if (!bandHeld) setChartBand(null);
      return;
    }
    if (banding && chartRailNote?.chart === banding.chart) setChartBand(chartRailNote);
  }, [banding, bandHeld, chartBand, chartRailNote]);
  const railNote = calloutPlaced ? null : (content?.note ?? null);
  // The note a diagram carries as a callout still marks its node first.
  const pageNotes = [...(content?.note ? [content.note] : []), ...(content?.moreNotes ?? []).map((object) => object.data)];
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
      className={`scene scene--${layout}${content ? ` scene--${kind}` : ''}`}
      data-scene={content ? kind : layout}
      inert={behindFocus}
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
          <div className="content-grid" style={railFloor !== null ? ({ '--rail-floor': `${railFloor}px` } as CSSProperties) : undefined}>
            <MainWithAux ref={mainRef} variant={content.mainVariant} aux={content.aux} onStage={state.agentObjects} onFocus={onFocus} drawn={pageNotes}>
              {content.main}
            </MainWithAux>
            <motion.aside ref={railRef} className="content-rail" {...railMotion}>
              {presence}
              <RailDetails
                state={state}
                metrics={content.metrics}
                note={railNote}
                noteObject={calloutPlaced ? undefined : content.noteObject}
                moreNotes={content.moreNotes}
                pageNotes={pageNotes}
                progressList={content.progressList}
                onFocus={onFocus}
                onOpenHistory={onOpenHistory}
                noteLeads={content.noteLeads}
                under={under}
                onFloor={setRailFloor}
                floor={railFloor}
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
