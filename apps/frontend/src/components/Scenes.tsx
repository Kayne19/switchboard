import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useState, type ReactNode } from 'react';
import type {
  ChartData,
  CodeData,
  ControllerState,
  DiagramData,
  DocumentData,
  MessageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { RUNTIME_CONVERSATION_ID } from '../controller/types';
import { buildCompositionModel, cast, objectsOfType, primaryObject } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ChartPrimitive } from '../primitives/ChartPrimitive';
import { CodeViewport } from '../primitives/CodeViewport';
import { DamoclesPresence } from '../primitives/DamoclesPresence';
import { DiagramPrimitive } from '../primitives/DiagramPrimitive';
import { DocumentViewport } from '../primitives/DocumentViewport';
import { LiveChatCard } from '../primitives/LiveChatCard';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { RichText } from '../primitives/RichText';
import { SceneFooter } from '../primitives/SceneFooter';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { TechFrame } from '../primitives/TechFrame';
import { ToolActivity } from '../primitives/ToolActivity';
import { TranscriptToggle } from '../primitives/TranscriptToggle';
import { ChartNotes, type ChartNote } from './ChartNotes';
import { SurfaceBoundary } from './SurfaceBoundary';

/** A text field an object's data may carry for the scene frame, or undefined
 * when that shape has none. */
function frameText(data: unknown, field: 'title' | 'subject' | 'label' | 'subtitle' | 'context'): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

interface SceneProps {
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
function RailNote({ note, noteObject, onFocus, onOpenHistory }: ExplanationProps) {
  return (
    <AnimatePresence initial={false}>
      {note ? (
        <ObjectMotion key="rail-note" objectId={noteObject?.id ?? 'speech-note'} className="rail-note" layout="position">
          <SurfaceBoundary surfaceId={noteObject?.id ?? 'speech-note'} resetKey={noteObject ?? note}>
            <AnnotationCard
              data={note}
              onFocus={noteObject ? () => onFocus(noteObject.id) : undefined}
              onOpenHistory={noteObject ? undefined : onOpenHistory}
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
              <ProgressPrimitive data={progress.data} />
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

// The details column beside every content visual: the metrics, live response,
// note, any progress the main column has no slot for, and tool activity. It is
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
      {liveMessage ? <LiveChatCard message={liveMessage} onOpenHistory={onOpenHistory} /> : null}
      <RailNote note={note} noteObject={noteObject} onFocus={onFocus} onOpenHistory={onOpenHistory} />
      <RailProgress progressList={progressList} onFocus={onFocus} />
      <ToolActivity activity={state.activity} reserveSpace={reserveActivity} />
    </div>
  );
}

// One object drawn inside a composed workspace, as the primary or in the aux
// row beneath it. Only a metric changes with the slot.
function composedPrimitive(object: SceneObject, slot: 'primary' | 'aux') {
  switch (object.type) {
    case 'chart':
      return <ChartPrimitive data={(object as SceneObject<ChartData>).data} />;
    case 'diagram':
      return <DiagramPrimitive data={(object as SceneObject<DiagramData>).data} id={object.id} />;
    case 'document':
      return <DocumentViewport data={(object as SceneObject<DocumentData>).data} />;
    case 'code':
      return <CodeViewport data={(object as SceneObject<CodeData>).data} />;
    case 'metric':
      return <MetricsPrimitive metrics={[object as SceneObject<MetricData>]} variant={slot === 'primary' ? 'primary' : undefined} />;
    case 'progress':
      return <ProgressPrimitive data={(object as SceneObject<ProgressData>).data} />;
    case 'note':
      return <AnnotationCard data={(object as SceneObject<NoteData>).data} />;
    default:
      return null;
  }
}

type IdleSceneProps = Pick<SceneProps, 'state' | 'onToggleListening'> & Partial<Pick<SceneProps, 'setTranscriptOpen'>>;

// With an opener, the idle stage keeps the transcript toggle in its
// conversation-page place, hidden until the pointer reaches the bottom band,
// so the typed line is reachable before anyone has spoken.
export function IdleScene({ state, onToggleListening, setTranscriptOpen }: IdleSceneProps) {
  const isPresent = useIsPresent();
  return (
    <motion.section className="scene scene--idle" data-scene="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <DamoclesPresence
        listening={state.listening}
        onToggleListening={onToggleListening}
        size="idle"
        showCaption={false}
      />
      {setTranscriptOpen && isPresent ? <TranscriptToggle reveal="hover" onOpen={() => setTranscriptOpen(true)} /> : null}
    </motion.section>
  );
}

export function ConversationScene({ state, onToggleListening, setTranscriptOpen }: SceneProps) {
  const comp = buildCompositionModel(state);
  const object =
    comp.runtimeConversation ??
    (comp.primary?.type === 'message' ? comp.primary : null);
  const fallbackMessage: MessageData = {
    context: 'OPERATOR LINE',
    tag: 'CURRENT RESPONSE / LIVE',
    segments: [{ text: 'Line open. Speak when ready.' }],
    channel: { name: 'VOICE', mode: 'PUSH-TO-TALK' },
    transcript: [],
  };
  const message = object ? cast.message(object).data : fallbackMessage;
  // Status/activity speech is rendered as an annotation elsewhere; it must not
  // replace the conversation's latest committed response. Before the first
  // response the line carries no text, and this scene alone says it is open.
  const segments = message.segments.length > 0 ? message.segments : fallbackMessage.segments;

  return (
    <motion.section className="scene scene--conversation" data-scene="conversation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <ConversationCorners />
      <div className="conversation-presence-band">
        <DamoclesPresence
          listening={state.listening}
          onToggleListening={onToggleListening}
          context={message.context ?? 'CONVERSATION'}
          size="conversation"
          showCaption={false}
        />
      </div>

      <ObjectMotion objectId={object?.id ?? "conversation"} className="conversation-answer">
        <TechFrame variant="answer" />
        <SurfaceBoundary surfaceId={object?.id ?? 'conversation'} resetKey={object ?? message}>
          <div className="conversation-answer__tag tech micro">{message.tag ?? 'CURRENT RESPONSE / 01'}</div>
          <div className="conversation-answer__text"><div className="conversation-answer__text-inner"><RichText segments={segments} /></div></div>
          <div className="conversation-answer__index tech micro">{message.caption ?? `${message.channel?.name ?? 'VOICE'} / LIVE`}</div>
        </SurfaceBoundary>
      </ObjectMotion>

      <div className="conversation-channel tech micro">
        CHANNEL / {message.channel?.name ?? 'VOICE'}<br />MODE / {message.channel?.mode ?? 'HANDS-FREE'}
      </div>
      <TranscriptToggle onOpen={() => setTranscriptOpen(true)} />
      <ToolActivity activity={state.activity} placement="conversation" />
    </motion.section>
  );
}

// Which chart panel each note is shown on: the chart it names, a compare
// chart's included, and otherwise the primary. Every note is shown -- a
// second note on the chart is annotated beside the first, not dropped --
// and with no note object on stage, a spoken explanation stands in on the
// primary.
function chartNotesByPanel(
  state: ControllerState,
  charts: Array<SceneObject<ChartData>>,
  primary: SceneObject<ChartData>,
): Map<string, ChartNote[]> {
  const byPanel = new Map<string, ChartNote[]>();
  const add = (chartId: string, note: ChartNote) => byPanel.set(chartId, [...(byPanel.get(chartId) ?? []), note]);
  const noteObjects = objectsOfType<NoteData>(state, 'note');
  for (const object of noteObjects) {
    const target = charts.find((chart) => chart.id === object.data.anchor?.target) ?? primary;
    add(target.id, { key: object.id, data: object.data, object });
  }
  if (noteObjects.length === 0) {
    const spoken = annotationForScene(state, undefined, liveChatMessage(state));
    if (spoken) add(primary.id, { key: 'speech-note', data: spoken });
  }
  return byPanel;
}

export function TrainingScene({ state, onToggleListening, onFocus, onOpenHistory }: SceneProps) {
  const charts = objectsOfType<ChartData>(state, 'chart');
  const metrics = objectsOfType<MetricData>(state, 'metric');
  const [progress, ...railProgress] = objectsOfType<ProgressData>(state, 'progress');
  const primary = charts.find((chart) => chart.role === 'primary') ?? charts[0];
  if (!primary) return <IdleScene state={state} onToggleListening={onToggleListening} />;
  // The notes lie over the panel of the chart they annotate rather than in a
  // band that shrinks it; the layer keeps them clear of one another, of the
  // points they name, and of the traces wherever the panel has the room.
  const notesByPanel = chartNotesByPanel(state, charts, primary);

  return (
    <motion.section className="scene scene--content scene--training" data-scene="training" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="scene-heading">
        <div className="scene-heading__title tech">{primary.data.title ?? 'TRAINING / RUN'}</div>
        <div className="scene-heading__sub tech micro">{primary.data.subtitle ?? 'LOSS TRACE / LIVE'}</div>
      </div>

      <div className="content-grid">
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
                        <ChartPrimitive data={chart.data} />
                      </FocusableSurface>
                    </ObjectSurface>
                    {notes.length > 0 ? (
                      <ChartNotes chart={chart} notes={notes} onFocus={onFocus} onOpenHistory={onOpenHistory} />
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

        <motion.aside className="content-rail" layout>
          <DamoclesPresence
            listening={state.listening}
            onToggleListening={onToggleListening}
            context={primary.data.context ?? 'TRAINING RUN'}
            size="rail"
            activity={state.activity}
          />
          {/* The notes sit on the charts here, so the rail carries none. */}
          <RailDetails state={state} metrics={metrics} note={null} progressList={railProgress} onFocus={onFocus} onOpenHistory={onOpenHistory} />
        </motion.aside>
      </div>
      <SceneFooter left="DISPLAY / COMPOSED" right={sceneCaption(primary, 'PRIMARY / LOSS TRACE')} />
    </motion.section>
  );
}

export function ArchitectureScene({ state, onToggleListening, onFocus, onOpenHistory }: SceneProps) {
  const [calloutPlaced, setCalloutPlaced] = useState(false);
  const primaryObjectValue = primaryObject(state);
  if (!primaryObjectValue) return <IdleScene state={state} onToggleListening={onToggleListening} />;
  const diagram = cast.diagram(primaryObjectValue);
  const noteObject = noteForTarget(objectsOfType<NoteData>(state, 'note'), diagram.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  const metrics = objectsOfType<MetricData>(state, 'metric');
  const progressList = objectsOfType<ProgressData>(state, 'progress');

  const railNote = calloutPlaced ? null : note;

  return (
    <motion.section className="scene scene--content scene--architecture" data-scene="architecture" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="scene-heading">
        <div className="scene-heading__title tech">{diagram.data.title ?? 'SYSTEM / DIAGRAM'}</div>
        <div className="scene-heading__sub tech micro">{diagram.data.subtitle ?? 'GRAPH / COMPOSED'}</div>
      </div>
      <div className="content-grid">
        <ObjectMotion objectId={diagram.id} className="content-main diagram-object">
          <TechFrame variant="rails" />
          <ObjectSurface object={diagram}>
            <FocusableSurface onActivate={() => onFocus(diagram.id)} ariaLabel="Expand diagram">
              <DiagramPrimitive data={diagram.data} id={diagram.id} note={note} onCalloutChange={setCalloutPlaced} />
            </FocusableSurface>
          </ObjectSurface>
        </ObjectMotion>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence listening={state.listening} onToggleListening={onToggleListening} context={diagram.data.context ?? 'SYSTEM MAP'} size="rail" activity={state.activity} />
          <RailDetails state={state} metrics={metrics} note={railNote} noteObject={calloutPlaced ? undefined : noteObject} progressList={progressList} onFocus={onFocus} onOpenHistory={onOpenHistory} />
        </motion.aside>
      </div>
      <SceneFooter left="DISPLAY / SYSTEM MAP" right={sceneCaption(diagram, 'TRACE / ACTIVE ROUTE')} />
    </motion.section>
  );
}

export function DocumentScene({ state, onToggleListening, onFocus, onOpenHistory }: SceneProps) {
  const primaryObjectValue = primaryObject(state);
  if (!primaryObjectValue) return <IdleScene state={state} onToggleListening={onToggleListening} />;
  const document = cast.document(primaryObjectValue);
  const noteObject = noteForTarget(objectsOfType<NoteData>(state, 'note'), document.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  const metrics = objectsOfType<MetricData>(state, 'metric');
  const progressList = objectsOfType<ProgressData>(state, 'progress');

  return (
    <motion.section className="scene scene--content scene--document" data-scene="document" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="scene-heading">
        <div className="scene-heading__title tech">DOCUMENT / {document.data.kind?.toUpperCase() ?? 'CONTENT'}</div>
        <div className="scene-heading__sub tech micro">CONTENT / ORIGINAL</div>
      </div>
      <div className="content-grid">
        <ObjectMotion objectId={document.id} className="content-main document-object">
          <ObjectSurface object={document}>
            <FocusableSurface onActivate={() => onFocus(document.id)} ariaLabel="Expand document">
              <DocumentViewport data={document.data} />
            </FocusableSurface>
          </ObjectSurface>
        </ObjectMotion>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence listening={state.listening} onToggleListening={onToggleListening} context={document.data.context ?? 'DOCUMENT'} size="rail" activity={state.activity} />
          <RailDetails state={state} metrics={metrics} note={note} noteObject={noteObject} progressList={progressList} onFocus={onFocus} onOpenHistory={onOpenHistory} />
        </motion.aside>
      </div>
      <SceneFooter left="CONTENT / ORIGINAL EMAIL" right={sceneCaption(document, 'CHROME / SWITCHBOARD')} />
    </motion.section>
  );
}

export function CodeScene({ state, onToggleListening, onFocus, onOpenHistory }: SceneProps) {
  const primaryObjectValue = primaryObject(state);
  if (!primaryObjectValue) return <IdleScene state={state} onToggleListening={onToggleListening} />;
  const code = cast.code(primaryObjectValue);
  const noteObject = noteForTarget(objectsOfType<NoteData>(state, 'note'), code.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  const metrics = objectsOfType<MetricData>(state, 'metric');
  const progressList = objectsOfType<ProgressData>(state, 'progress');

  return (
    <motion.section className="scene scene--content scene--code" data-scene="code" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="scene-heading">
        <div className="scene-heading__title tech">{code.data.title ?? 'SOURCE / LIVE'}</div>
        <div className="scene-heading__sub tech micro">{code.data.file ?? 'SOURCE'}</div>
      </div>
      <div className="content-grid">
        <ObjectMotion objectId={code.id} className="content-main code-object">
          <ObjectSurface object={code}>
            <FocusableSurface onActivate={() => onFocus(code.id)} ariaLabel="Expand code">
              <CodeViewport data={code.data} />
            </FocusableSurface>
          </ObjectSurface>
        </ObjectMotion>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence listening={state.listening} onToggleListening={onToggleListening} context={code.data.context ?? 'SOURCE'} size="rail" activity={state.activity} />
          <RailDetails state={state} metrics={metrics} note={note} noteObject={noteObject} progressList={progressList} onFocus={onFocus} onOpenHistory={onOpenHistory} />
        </motion.aside>
      </div>
      <SceneFooter left="FRAME / INTERRUPTED RAILS" right={sceneCaption(code, 'DISPLAY / SOURCE')} />
    </motion.section>
  );
}

const AUX_VISUAL_TYPES = new Set(['chart', 'diagram', 'document', 'code']);

export function ComposedScene({ state, onToggleListening, onFocus, onOpenHistory }: SceneProps) {
  const comp = buildCompositionModel(state);
  const primary = comp.primary;
  if (!primary) return <IdleScene state={state} onToggleListening={onToggleListening} />;

  const primaryMetrics = comp.primaryMetrics;
  const isMetricPrimary = primary.type === 'metric' || primaryMetrics.length > 0;

  const noteObjects = comp.allAgentObjects.filter((object) => object.type === 'note') as Array<SceneObject<NoteData>>;
  const noteObject = noteForTarget(noteObjects, primary.id);
  const note = annotationForScene(state, noteObject, liveChatMessage(state));
  const metrics = comp.allAgentObjects.filter((o) => o.type === 'metric') as Array<SceneObject<MetricData>>;
  const progressList = comp.allAgentObjects.filter((o) => o.type === 'progress') as Array<SceneObject<ProgressData>>;
  const primaryMetricIds = new Set(primaryMetrics.map((m) => m.id));
  const railMetrics = isMetricPrimary
    ? metrics.filter((metric) => !primaryMetricIds.has(metric.id))
    : metrics;
  const railNote = noteObject?.id === primary.id ? null : note;
  // Everything the rail does not carry shares one visible aux row below the
  // primary -- compare objects, secondary visuals, and progress -- so an
  // accepted object is never lost to the layout. Metrics and the note stay
  // in the rail.
  const auxObjects: SceneObject[] = [
    ...comp.compare,
    ...comp.secondary.filter((o) => AUX_VISUAL_TYPES.has(o.type)),
    ...progressList.filter((p) => p.id !== primary.id && !comp.compare.some((c) => c.id === p.id)),
  ];

  // The same precedence the backend's view summary reports to the agent.
  const title = frameText(primary.data, 'title') ?? frameText(primary.data, 'subject') ?? frameText(primary.data, 'label') ?? 'COMPOSED WORKSPACE';
  const subtitle = frameText(primary.data, 'subtitle') ?? 'STRUCTURED SCENE';

  return (
    <motion.section className="scene scene--content scene--composed" data-scene="composed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="scene-heading">
        <div className="scene-heading__title tech">{title}</div>
        <div className="scene-heading__sub tech micro">{subtitle}</div>
      </div>
      <div className="content-grid">
        <motion.div className={`content-main composed-main${isMetricPrimary ? ' composed-main--metric-primary' : ''}`} layout>
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
          {auxObjects.length > 0 ? (
            <div className="composed-aux">
              {auxObjects.map((object) => (
                <ObjectMotion
                  key={object.id}
                  objectId={object.id}
                  className={`composed-aux-object composed-aux-object--${object.type}`}
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
          ) : null}
        </motion.div>
        <motion.aside className="content-rail" layout>
          <DamoclesPresence
            listening={state.listening}
            onToggleListening={onToggleListening}
            context={frameText(primary.data, 'context') ?? 'COMPOSED'}
            size="rail"
            activity={state.activity}
          />
          <RailDetails
            state={state}
            metrics={railMetrics}
            note={railNote}
            noteObject={noteObject?.id === primary.id ? undefined : noteObject}
            progressList={[]}
            onFocus={onFocus}
            onOpenHistory={onOpenHistory}
          />
        </motion.aside>
      </div>
      <SceneFooter left="DISPLAY / COMPOSED" right={sceneCaption(primary, 'SYSTEM / ACTIVE')} />
    </motion.section>
  );
}
