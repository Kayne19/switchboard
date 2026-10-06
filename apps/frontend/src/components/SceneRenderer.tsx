import { AnimatePresence, LayoutGroup, MotionConfig } from "motion/react";
import { buildCompositionModel, sceneKind } from "../app/sceneModel";
import type { ControllerState } from "../controller/types";
import { useController } from "../controller/context";
import { DamoclesPresence } from "../primitives/DamoclesPresence";
import { FocusLayer, focusNotes } from "./FocusLayer";
import { SurfaceBoundary } from "./SurfaceBoundary";
import { TranscriptDrawer } from "./TranscriptDrawer";
import { SceneShell } from "./Scenes";

interface SceneContentProps {
  state: ControllerState;
  dispatch: ReturnType<typeof useController>["dispatch"];
  transcriptOpen: boolean;
  setTranscriptOpen: (open: boolean) => void;
  voiceRuntime: ReturnType<typeof useController>["voiceRuntime"];
  onToggleListening: () => void;
}

function SceneContent({
  state,
  dispatch,
  transcriptOpen,
  setTranscriptOpen,
  voiceRuntime,
  onToggleListening,
}: SceneContentProps) {
  const kind = sceneKind(state);
  const focusedObject = state.focusId
    ? (state.objects[state.focusId] ?? null)
    : null;
  const conversation = buildCompositionModel(state).runtimeConversation;
  // When a live voice transport is present the Damocles presence drives a real
  // call turn; in demo mode it only toggles the visual listening state.
  const shared = {
    state,
    onToggleListening,
    onFocus: (id: string | null) => dispatch({ op: "focus", id }),
    // An explanation offers the history only when there is one to open.
    onOpenHistory: conversation ? () => setTranscriptOpen(true) : undefined,
    setTranscriptOpen,
  };

  return (
    <LayoutGroup id="switchboard-layout">
      <main className="stage" data-scene-kind={kind}>
        <AnimatePresence mode="sync" initial={false}>
          <SceneShell key={kind} kind={kind} {...shared} />
        </AnimatePresence>
        <TranscriptDrawer
          open={transcriptOpen}
          lines={conversation?.data.transcript ?? []}
          onClose={() => setTranscriptOpen(false)}
          onSend={voiceRuntime?.sendText}
        />
        <FocusLayer
          object={focusedObject}
          objects={state.agentObjects}
          notes={focusNotes(state, focusedObject)}
          onClose={() => dispatch({ op: "focus", id: null })}
        />
      </main>
    </LayoutGroup>
  );
}

// Deliberately outside SceneShell: this fallback must still render when the
// shell itself is what failed. See "Scene shell" in apps/frontend/ARCHITECTURE.md.
function UnavailableStage({
  state,
  onToggleListening,
}: Pick<SceneContentProps, "state" | "onToggleListening">) {
  return (
    <main className="stage" data-scene-kind="unavailable">
      <section className="scene scene--idle">
        <DamoclesPresence
          listening={state.listening}
          onToggleListening={onToggleListening}
          size="idle"
          showCaption={false}
        />
        <div className="stage-unavailable tech micro">DISPLAY / UNAVAILABLE</div>
      </section>
    </main>
  );
}

export function SceneRenderer() {
  const { state, dispatch, transcriptOpen, setTranscriptOpen, voiceRuntime } =
    useController();
  const onToggleListening = () =>
    voiceRuntime
      ? voiceRuntime.toggleTurn()
      : dispatch({ op: "listen", on: !state.listening });

  // Under prefers-reduced-motion, motion's transform and layout animations
  // are skipped: the presence no longer slides in from the centre and an
  // object no longer moves to its new slot, they are drawn where they end.
  // Opacity still fades. Without it every layout animation ignored the
  // setting (DESIGN_SYSTEM.md, "Respect prefers-reduced-motion"), and the
  // visual goldens, taken under reduced motion, were compared with a frame
  // from the middle of the move or with the settled page, by chance. The
  // elements that move take no layout props at all then (useLayoutMotion):
  // motion's instant layout animation could leave a box at its old size.
  return (
    <MotionConfig reducedMotion="user">
      <SurfaceBoundary
        surfaceId="display"
        resetKey={state.objects}
        fallback={
          <UnavailableStage
            state={state}
            onToggleListening={onToggleListening}
          />
        }
      >
        <SceneContent
          state={state}
          dispatch={dispatch}
          transcriptOpen={transcriptOpen}
          setTranscriptOpen={setTranscriptOpen}
          voiceRuntime={voiceRuntime}
          onToggleListening={onToggleListening}
        />
      </SurfaceBoundary>
    </MotionConfig>
  );
}
