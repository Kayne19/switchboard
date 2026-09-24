import { AnimatePresence, LayoutGroup } from "motion/react";
import { buildCompositionModel, sceneKind } from "../app/sceneModel";
import type { ControllerState } from "../controller/types";
import { useController } from "../controller/context";
import { DamoclesPresence } from "../primitives/DamoclesPresence";
import { FocusLayer } from "./FocusLayer";
import { SurfaceBoundary } from "./SurfaceBoundary";
import { TranscriptDrawer } from "./TranscriptDrawer";
import {
  ArchitectureScene,
  CodeScene,
  ComposedScene,
  ConversationScene,
  DocumentScene,
  IdleScene,
  TrainingScene,
} from "./Scenes";

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
          {kind === "idle" ? (
            <IdleScene
              key="idle"
              state={state}
              onToggleListening={shared.onToggleListening}
            />
          ) : null}
          {kind === "conversation" ? (
            <ConversationScene key="conversation" {...shared} />
          ) : null}
          {kind === "training" ? (
            <TrainingScene key="training" {...shared} />
          ) : null}
          {kind === "architecture" ? (
            <ArchitectureScene key="architecture" {...shared} />
          ) : null}
          {kind === "document" ? (
            <DocumentScene key="document" {...shared} />
          ) : null}
          {kind === "code" ? <CodeScene key="code" {...shared} /> : null}
          {kind === "composed" ? (
            <ComposedScene key="composed" {...shared} />
          ) : null}
        </AnimatePresence>
        <TranscriptDrawer
          open={transcriptOpen}
          lines={conversation?.data.transcript ?? []}
          onClose={() => setTranscriptOpen(false)}
          onSend={voiceRuntime?.sendText}
        />
        <FocusLayer
          object={focusedObject}
          onClose={() => dispatch({ op: "focus", id: null })}
        />
      </main>
    </LayoutGroup>
  );
}

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

  return (
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
  );
}
