import { motion, useIsPresent } from 'motion/react';
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type {
  ControllerState,
  MessageData,
  NoteData,
  SceneObject,
} from '../controller/types';
import { cast, VISUAL_TYPES, type CompositionModel } from '../app/sceneModel';
import { useLayoutMotion } from '../hooks/useLayoutMotion';
import { useMeasured } from '../hooks/useMeasured';
import { DamoclesPresence } from '../primitives/DamoclesPresence';
import { drawsCallout } from '../primitives/DiagramPrimitive';
import { ListViewport } from '../primitives/ListViewport';
import { SpokenLog } from '../primitives/SpokenLog';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ChannelStack } from '../primitives/ChannelStack';
import { SceneFooter } from '../primitives/SceneFooter';
import { ExpandableSurface } from '../primitives/ExpandableSurface';
import { TechFrame } from '../primitives/TechFrame';
import { ToolActivity } from '../primitives/ToolActivity';
import { TranscriptToggle } from '../primitives/TranscriptToggle';
import { renderObject } from './renderObject';
import { SurfaceBoundary } from './SurfaceBoundary';
import { composedContent } from './ComposedScene';
import { focusNotes, StagedObject } from './FocusLayer';
import { objectContent } from './ObjectScene';
import { RailDetails } from './Rail';
import { SystemPanel } from './SystemPanel';
import { ObjectSurface, StageColumn, type SceneContent, type SceneProps } from './sceneContent';
import { trainingContent, type ChartRailNote } from './TrainingScene';

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
  // A row with no room for every cell scrolls (ListViewport); it opens
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
            <ExpandableSurface onActivate={() => onFocus(object.id)} ariaLabel={`Expand ${object.type}`}>
              {renderObject(object, 'aux', { onStage, notes: drawn })}
            </ExpandableSurface>
          </ObjectSurface>
        </ObjectMotion>
      ))}
    </ListViewport>
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

// ---- End of the aux row ----

// ---- Values the shell reads from the layout ----

// Whether the rail stands under the main column (a portrait stage) rather
// than beside it, read from where the two boxes lie in their grid, not from
// a media query. Where it does, the rail's note reads whole (useRailFit),
// and the note a single chart cannot hold lies in a band under it. A scene
// whose rail stays beside its column re-renders nothing for it.
function useRailUnder(active: boolean, gridRef: RefObject<HTMLDivElement | null>, mainRef: RefObject<HTMLDivElement | null>, railRef: RefObject<HTMLElement | null>): boolean {
  const under = useMeasured(
    () => (active ? gridRef.current : null),
    () => {
      const main = mainRef.current;
      const rail = railRef.current;
      return main !== null && rail !== null && main.offsetHeight > 0 && rail.offsetTop >= main.offsetTop + main.offsetHeight - 1;
    },
    { initial: false, children: true },
    [active, gridRef, mainRef, railRef],
  );
  return active && under;
}

// What the main column was last read to draw: the note it was read for
// (null before the first read), and whether a graph in it carries that
// note as a callout.
interface CalloutRead {
  note: NoteData | null;
  drawn: boolean;
}
const UNREAD: CalloutRead = { note: null, drawn: false };
const sameRead = (a: CalloutRead, b: CalloutRead) => a.note === b.note && a.drawn === b.drawn;

// Whether the main slot's graph carries `note`, the scene's note where the
// graph may carry it (`mayCarryCallout`), as a callout: the rail then
// leaves it out (#390). Only the graph knows whether it does, for the room
// it is laid out in, so the page reads it from what is drawn (useMeasured):
// in the commit the note arrives in, and again whenever the drawing
// changes, before a frame is painted. The placement is computed here, in
// render, from that read. A graph that goes -- its object changed, or
// failed to draw -- draws no callout, and the read gives the note back to
// the rail with no word from the graph.
function useCalloutPlaced(mainRef: RefObject<HTMLDivElement | null>, note: NoteData | undefined): boolean {
  const read = useMeasured(
    () => (note ? mainRef.current : null),
    (main): CalloutRead => ({ note: note ?? null, drawn: drawsCallout(main) }),
    { initial: UNREAD, same: sameRead, changes: true },
    [mainRef, note],
  );
  if (!note) return false;
  // Read for this note: where the drawing put it.
  if (read.note === note) return read.drawn;
  // Not read yet: where the drawing put the last note it was read for, the
  // best guess in the same room (a note updated in place does not move);
  // with none, out of the rail, so the rail never mounts a card the drawing
  // then takes.
  return read.note === null || read.drawn;
}

// How tall the line's error stands at the head of the corner stack: every
// layout gives it that room above its foot (`--line-error-room`), so the
// error covers nothing the page draws. With no error there is no room.
function useLineErrorRoom(error: string | null, errorRef: RefObject<HTMLDivElement | null>): number {
  const room = useMeasured(
    () => (error === null ? null : errorRef.current),
    (element) => element.offsetHeight,
    { initial: 0 },
    [error, errorRef],
  );
  return error === null ? 0 : room;
}

// ---- End of the values read from the layout ----

const FALLBACK_MESSAGE: MessageData = {
  context: 'OPERATOR LINE',
  tag: 'CURRENT RESPONSE / LIVE',
  segments: [{ text: 'Line open. Speak when ready.' }],
  channel: { name: 'VOICE' },
  transcript: [],
};

// The conversation page's live box: the runtime conversation, or an agent
// message on stage. Status/activity speech is rendered as an annotation
// elsewhere; it must not replace the conversation's latest committed
// response. Before the first response the line carries no text, and this
// page alone says it is open.
function ConversationAnswer({ composition }: { composition: CompositionModel }) {
  const object = composition.runtimeConversation ?? (composition.primary?.type === 'message' ? composition.primary : null);
  const message = object ? cast.message(object).data : FALLBACK_MESSAGE;
  const segments = message.segments.length > 0 ? message.segments : FALLBACK_MESSAGE.segments;
  return (
    <ObjectMotion objectId={object?.id ?? 'conversation'} className="conversation-answer">
      <TechFrame variant="answer" />
      <SurfaceBoundary surfaceId={object?.id ?? 'conversation'} resetKey={object ?? message}>
        <div className="conversation-answer__tag tech micro">{message.tag ?? 'CURRENT RESPONSE / 01'}</div>
        <SpokenLog message={{ ...message, segments }} className="conversation-answer__text" innerClassName="conversation-answer__text-inner" />
        <div className="conversation-answer__index tech micro">{message.caption ?? `${message.channel?.name ?? 'VOICE'} / LIVE`}</div>
      </SurfaceBoundary>
    </ObjectMotion>
  );
}

function sceneContent(
  props: SceneProps,
  chartRailNote: ChartRailNote | null,
  onChartRailNote: (chartId: string, key: string, away: boolean) => void,
  chartBand: ChartRailNote | null,
): SceneContent | null {
  switch (props.kind) {
    case 'idle':
    case 'conversation':
    case 'theater':
    case 'system':
      return null;
    case 'training':
      return trainingContent(props, chartRailNote, onChartRailNote, chartBand);
    case 'composed':
      return composedContent(props);
    default:
      return objectContent(props);
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
  const { kind, composition, state, onToggleListening, onFocus, onOpenHistory, setTranscriptOpen, handsFree, onToggleMode, onExitView, line, behindModal = false } = props;
  const isPresent = useIsPresent();
  // A chart hands the rail the one note it leaves out so the others have
  // places clear of its data.
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
  const content = sceneContent(props, chartRailNote, onChartRailNote, chartBand);
  // The theater view's subject: the primary, alone on the stage.
  const staged = kind === 'theater' ? composition.primary : null;
  const layout = content ? 'content' : kind === 'conversation' || kind === 'system' ? kind : staged ? 'theater' : 'idle';
  const gridRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const under = useRailUnder(content !== null, gridRef, mainRef, railRef);
  // A graph can carry the note as a callout beside the node it names; the
  // rail then leaves it out.
  const calloutPlaced = useCalloutPlaced(mainRef, content?.calloutNote);
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
  // The system view shows the line's error as its STATUS row.
  const lineError = layout !== 'system' ? state.lineError : null;
  const errorRef = useRef<HTMLDivElement>(null);
  const errorRoom = useLineErrorRoom(lineError, errorRef);
  const presence = (
    <DamoclesPresence
      listening={state.listening}
      onToggleListening={onToggleListening}
      context={content?.context}
      size={content ? 'rail' : layout === 'conversation' ? 'conversation' : layout === 'theater' || layout === 'system' ? 'compact' : 'idle'}
      showCaption={content !== null}
      activity={state.activity}
    />
  );

  return (
    <motion.section
      className={`scene scene--${layout}${content ? ` scene--${kind}` : ''}`}
      data-scene={content ? kind : layout}
      // A scene that is leaving is inert too: it is drawn until its exit
      // ends, and the copy AnimatePresence keeps has the props it had before
      // a modal opened, so its MODE was a tab stop behind the history (#268).
      inert={behindModal || !isPresent}
      style={errorRoom > 0 ? ({ '--line-error-room': `${errorRoom}px` } as CSSProperties) : undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Every page carries the corner stack once (#180): the shell draws it
          here, not a composition, so the idle, conversation and content
          pages cannot drift apart on what the microphone is doing. */}
      <ChannelStack handsFree={handsFree} onToggleMode={onToggleMode} lineError={lineError} errorRef={errorRef} />
      {content ? (
        <>
          <div className="scene-heading">
            <div className="scene-heading__title tech">{content.title}</div>
            <div className="scene-heading__sub tech micro">{content.subtitle}</div>
          </div>
          <div ref={gridRef} className="content-grid" style={railFloor !== null ? ({ '--rail-floor': `${railFloor}px` } as CSSProperties) : undefined}>
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
          <SceneFooter right={content.caption} />
        </>
      ) : layout === 'conversation' ? (
        <>
          <ConversationCorners />
          <div className="conversation-presence-band">{presence}</div>
          <ConversationAnswer composition={composition} />
          <ToolActivity activity={state.activity} placement="conversation" />
        </>
      ) : staged ? (
        <>
          {/* The theater view (#277): the primary at the size focus gives
              it, with the notes about it, and the one way out; Damocles
              stays, compact, so a caller on push-to-talk can still speak. */}
          <StagedObject
            object={staged}
            objects={state.agentObjects}
            notes={focusNotes(state, staged)}
            label={`THEATER / ${staged.type.toUpperCase()}`}
            action="EXIT / ESC"
            onAction={onExitView}
            variant="theater"
          />
          <div className="theater__presence">{presence}</div>
        </>
      ) : layout === 'system' ? (
        <>
          {/* The system view (#277): the line and its controls, with
              Damocles compact beside them, as in the theater. */}
          <SystemPanel line={line} onExit={onExitView} />
          <div className="theater__presence">{presence}</div>
        </>
      ) : (
        presence
      )}
      {/* A content page reaches the history through its rail instead. */}
      {layout !== 'content' && isPresent ? <TranscriptToggle reveal={layout === 'conversation' ? 'resting' : 'hover'} onOpen={() => setTranscriptOpen(true)} /> : null}
    </motion.section>
  );
}

