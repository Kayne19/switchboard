// What a scene hands the shell (`SceneContent`), what it is given
// (`SceneProps`), and the pieces every scene draws with. The shell is
// `SceneShell` in Scenes.tsx; the scenes are TrainingScene.tsx,
// ObjectScene.tsx and ComposedScene.tsx.
import { motion } from 'motion/react';
import type { ReactNode, RefObject } from 'react';
import type {
  ControllerState,
  MessageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
} from '../controller/types';
import { RUNTIME_CONVERSATION_ID } from '../controller/types';
import { anchoredNote, cast, type CompositionModel, type SceneKind } from '../app/sceneModel';
import type { LineControls } from '../controller/context';
import { useLayoutMotion } from '../hooks/useLayoutMotion';
import { SurfaceBoundary } from './SurfaceBoundary';

export interface SceneProps {
  /** The composition to draw; the shell keeps one page for every kind. */
  kind: SceneKind;
  /** The composition of `state`, built once for this render (`SceneRenderer`): every scene reads its primary and the visuals beside it from here, so no scene can pick a primary of its own. */
  composition: CompositionModel;
  state: ControllerState;
  onToggleListening: () => void;
  onFocus: (id: string | null) => void;
  /** Opens the conversation history drawer; absent while there is no conversation. */
  onOpenHistory?: () => void;
  setTranscriptOpen: (open: boolean) => void;
  /** Whether the voice runtime reports hands-free wake-word listening (#180). */
  handsFree: boolean;
  /** Switches the mode through the voice runtime; absent in demo mode, where there is no transport to switch. */
  onToggleMode?: () => void;
  /** The focus layer or the history, a modal, is open over the scene: the scene is inert behind it (`useModalFocus`). */
  behindModal?: boolean;
  /** The caller leaves the view the page is in for auto: the theater's and the system view's EXIT. */
  onExitView: () => void;
  /** The line and its controls, for the system view; absent in demo mode, where there is no call. */
  line?: LineControls;
}

export function annotationForScene(
  state: ControllerState,
  noteObject: SceneObject<NoteData> | undefined,
  liveMessage: MessageData | null,
): NoteData | null {
  // Notes are durable display objects. A later chat response may supply a
  // transient explanation only when no note is present; it must never mutate
  // or visually replace an explicit note. A spoken reply already reads in the
  // live chat card when the scene shows one, so the slot then carries only
  // speech the card does not: an agent `say`. An error on the line is not
  // speech (`ControllerState.lineError`): the shell draws it at the head of
  // the corner stack.
  if (noteObject) return noteObject.data;
  if (!state.speech) return null;
  if (liveMessage && state.speech.target === RUNTIME_CONVERSATION_ID) return null;
  return { tag: 'DAMOCLES / EXPLANATION', segments: [{ text: state.speech.text }] };
}

export function noteForTarget(
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
export function liveChatMessage(state: ControllerState): MessageData | null {
  const object = state.runtimeObjects[RUNTIME_CONVERSATION_ID];
  if (object?.type !== 'message') return null;
  const message = cast.message(object).data;
  return message.segments.length > 0 ? message : null;
}

export function sceneCaption(object: SceneObject, fallback: string): string {
  const caption = (object.data as { caption?: unknown }).caption;
  return typeof caption === 'string' && caption.trim() ? caption : fallback;
}

export function ObjectSurface({ object, children }: { object: SceneObject; children: ReactNode }) {
  return (
    <SurfaceBoundary surfaceId={object.id} resetKey={object}>
      {children}
    </SurfaceBoundary>
  );
}

// What a content scene fills the shell with: the text of its frame, its main
// slot, the visuals that slot leaves out, and the objects the rail carries
// for it. The shell draws the rest.
export interface SceneContent {
  title: string;
  subtitle: string;
  context: string;
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
  /** The scene's note, where the main slot's graph may carry it as a callout (`mayCarryCallout`): the rail leaves it out while the drawing does (`useCalloutPlaced`). */
  calloutNote?: NoteData;
  /** The primary chart and the notes on it, by key: a band holds a note while it is one of them. */
  chartNotes?: { chart: string; keys: string[] };
}

// A column of the stage that moves and resizes with its layout: the main
// column, and a scene's own column in its main slot (`useLayoutMotion`).
export function StageColumn({ className, ref, children }: { className: string; ref?: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const layoutMotion = useLayoutMotion({ layout: true });
  return (
    <motion.div ref={ref} className={className} {...layoutMotion}>
      {children}
    </motion.div>
  );
}
