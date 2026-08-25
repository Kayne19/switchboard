import { AnimatePresence, LayoutGroup } from 'motion/react';
import { sceneKind } from '../app/sceneModel';
import { useController } from '../controller/context';
import { FocusLayer } from './FocusLayer';
import { ArchitectureScene, CodeScene, ConversationScene, DocumentScene, IdleScene, TrainingScene } from './Scenes';

export function SceneRenderer() {
  const { state, dispatch, transcriptOpen, setTranscriptOpen } = useController();
  const kind = sceneKind(state);
  const focusedObject = state.focusId ? state.objects[state.focusId] ?? null : null;
  const shared = {
    state,
    onToggleListening: () => dispatch({ op: 'listen', on: !state.listening }),
    onFocus: (id: string | null) => dispatch({ op: 'focus', id }),
    transcriptOpen,
    setTranscriptOpen,
  };

  return (
    <LayoutGroup id="switchboard-layout">
      <main className="stage" data-scene-kind={kind}>
        <AnimatePresence mode="sync" initial={false}>
          {kind === 'idle' ? <IdleScene key="idle" state={state} onToggleListening={shared.onToggleListening} /> : null}
          {kind === 'conversation' ? <ConversationScene key="conversation" {...shared} /> : null}
          {kind === 'training' ? <TrainingScene key="training" {...shared} /> : null}
          {kind === 'architecture' ? <ArchitectureScene key="architecture" {...shared} /> : null}
          {kind === 'document' ? <DocumentScene key="document" {...shared} /> : null}
          {kind === 'code' ? <CodeScene key="code" {...shared} /> : null}
        </AnimatePresence>
        <FocusLayer object={focusedObject} onClose={() => dispatch({ op: 'focus', id: null })} />
      </main>
    </LayoutGroup>
  );
}
