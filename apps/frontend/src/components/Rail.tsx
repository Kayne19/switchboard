// The rail beside a content scene's main column: metrics, progress, the
// live response, the notes and tool activity, and how it fits them when it
// stands under the column (`useRailFit`). Drawn by `SceneShell`.
import { AnimatePresence } from 'motion/react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type {
  ControllerState,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { railNoteTarget } from '../app/noteItems';
import { useMeasured } from '../hooks/useMeasured';
import { AnnotationCard, type NoteTarget } from '../primitives/AnnotationCard';
import { LiveChatCard } from '../primitives/LiveChatCard';
import { MetricsPrimitive } from '../primitives/MetricsPrimitive';
import { ObjectMotion } from '../primitives/ObjectMotion';
import { ProgressPrimitive } from '../primitives/ProgressPrimitive';
import { FocusableSurface } from '../primitives/FocusableSurface';
import { ToolActivity } from '../primitives/ToolActivity';
import { SurfaceBoundary } from './SurfaceBoundary';
import { liveChatMessage, ObjectSurface } from './sceneContent';

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
  const crowded = useMeasured(() => (watching ? ref.current : null), (column) => column.scrollHeight > column.clientHeight + 1, { initial: false, children: true }, [ref, watching]);
  return watching && crowded;
}

interface RailFit {
  /** The column cannot hold all it carries: the note leads it. */
  leads: boolean;
  /** The column's foot has no room for the activity panel whole: it is set aside. */
  away: boolean;
  /** How tall the note reads whole in, CSS pixels; `null` with no note. */
  floor: number | null;
}
const FITS: RailFit = { leads: false, away: false, floor: null };
const sameFit = (a: RailFit, b: RailFit) => a.leads === b.leads && a.away === b.away && a.floor === b.floor;

// A part counts at its own height and margins (a live response, which
// grows into the column's free space, at its least), never at what the fit
// decides.
function railFit(column: HTMLElement): RailFit {
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
  return {
    leads: note !== undefined && parts.length > 1 && content > room + 1,
    away: panel > 0 && content + panel > room + 1,
    floor: note ? Math.ceil(least(note)) : null,
  };
}

// Under the main column (a portrait stage) the rail is Damocles beside the
// note, and the note reads whole there, as Kayne approved the portrait
// goldens: it keeps its own height (the stylesheet), and the column says
// how tall that is (`onFloor`), so the rail grows to hold it and the main
// column gives up as much, keeping the larger share (the grid). What else
// the rail carries does not size it: where it does not all fit, the note
// leads, whole, the rest after it in the column's scroll; and the activity
// panel stands at the column's foot only where it fits there whole -- where
// it does not, Damocles's caption, which names the tool at work wherever
// the rail stands, is what the caller sees of it.
//
// The fit feeds itself -- the floor sets the column's height, the panel set
// aside leaves its flow -- so the column is measured again in the rail the
// floor makes (`floor` in its deps), in the same commit; what the observers
// measure is committed before the frame is painted (useMeasured), so no
// frame shows a rail half decided.
function useRailFit(ref: RefObject<HTMLDivElement | null>, under: boolean, onFloor: (height: number | null) => void, floor: number | null): RailFit {
  const fit = useMeasured(() => (under ? ref.current : null), railFit, { initial: FITS, same: sameFit, children: true, changes: true }, [ref, under, floor]);
  const shown = under ? fit : FITS;
  useLayoutEffect(() => onFloor(shown.floor), [onFloor, shown.floor]);
  return shown;
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
export function RailDetails({ state, metrics, note, noteObject, moreNotes = NO_NOTES, pageNotes, progressList, onFocus, onOpenHistory, noteLeads = false, under = false, onFloor = noFloor, floor = null }: RailDetailsProps) {
  const liveMessage = liveChatMessage(state);
  const columnRef = useRef<HTMLDivElement>(null);
  const crowded = useCrowded(columnRef, !under && noteLeads && (note !== null || moreNotes.length > 0));
  const fit = useRailFit(columnRef, under, onFloor, floor);
  const stacked = moreNotes.length > 0;
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
    <div ref={columnRef} className="content-rail__details">
      {metrics.length > 0 ? <MetricsPrimitive metrics={metrics} slot="rail" /> : null}
      <RailProgress progressList={progressList} onFocus={onFocus} />
      {liveMessage ? <LiveChatCard message={liveMessage} onOpenHistory={onOpenHistory} /> : null}
      <RailNote note={note} noteObject={noteObject} onFocus={onFocus} onOpenHistory={onOpenHistory} named={railNoteTarget(state.agentObjects, drawn, note)} leads={leads} stacked={stacked} />
      <RailMoreNotes notes={moreNotes} drawn={drawn} onFocus={onFocus} objects={state.agentObjects} leads={leads} />
      <ToolActivity activity={state.activity} reserveSpace={reserveActivity} away={fit.away} />
    </div>
  );
}
