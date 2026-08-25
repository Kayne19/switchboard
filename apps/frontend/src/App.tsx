import { useEffect, useRef, useState } from 'react';
import { SceneRenderer } from './components/SceneRenderer';
import { ControllerPanel } from './components/ControllerPanel';
import { IRDrawer } from './components/IRDrawer';
import { useController } from './controller/context';
import type { FixtureName } from './controller/types';
import { PROTOCOL_OPERATIONS } from './controller/reducer';
import { assertControllerAction } from './controller/validation';
import { sceneOrder } from './design/tokens';
import { RuntimeIntegration } from './integration/runtime';

const isFixture = (value: string | null): value is FixtureName => Boolean(value && sceneOrder.includes(value as FixtureName));

export default function App() {
  const { state, dispatch, run, loadFixture, fixture, transcriptOpen, setTranscriptOpen } = useController();
  const [controllerOpen, setControllerOpen] = useState(false);
  const [irOpen, setIrOpen] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const touchStart = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null);
  const initialized = useRef(false);
  const [demoMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('scene') || params.get('demo') === '1';
  });

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('scene');
    if (demoMode) loadFixture(isFixture(requested) ? requested : 'idle');
    if (params.get('chrome') === '0') document.body.classList.add('presentation-mode');
  }, [demoMode, loadFixture]);

  useEffect(() => {
    window.SwitchboardController = {
      dispatch: (action: unknown) => dispatch(assertControllerAction(action)),
      run: (actions: unknown[]) => run(actions.map(assertControllerAction)),
      load: loadFixture,
      state: () => stateRef.current,
      protocol: PROTOCOL_OPERATIONS,
    };
  }, [dispatch, run, loadFixture]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select') && event.key !== 'Escape') return;

      if (event.key === 'Escape') {
        if (state.focusId) dispatch({ op: 'focus', id: null });
        else if (transcriptOpen) setTranscriptOpen(false);
        else if (controllerOpen) setControllerOpen(false);
        else if (irOpen) setIrOpen(false);
        return;
      }

      if (!demoMode) return;

      const index = Number(event.key) - 1;
      if (index >= 0 && index < sceneOrder.length) {
        loadFixture(sceneOrder[index]);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'l') dispatch({ op: 'listen', on: !state.listening });
      if (key === 'c') setControllerOpen((value) => !value);
      if (key === 'j') setIrOpen((value) => !value);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controllerOpen, demoMode, dispatch, irOpen, loadFixture, setTranscriptOpen, state.focusId, state.listening, transcriptOpen]);

  useEffect(() => {
    const onTouchStart = (event: TouchEvent) => {
      if (!demoMode) return;
      if (event.touches.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button,input,textarea,.code-viewport__scroll,.document-viewport__body,.focus-layer,.controller-panel,.ir-drawer,.transcript')) return;
      touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, target: event.target };
    };
    const onTouchEnd = (event: TouchEvent) => {
      const start = touchStart.current;
      touchStart.current = null;
      if (!start || event.changedTouches.length !== 1) return;
      const dx = event.changedTouches[0].clientX - start.x;
      const dy = event.changedTouches[0].clientY - start.y;
      if (Math.abs(dx) < 58 || Math.abs(dx) < Math.abs(dy)) return;
      const current = sceneOrder.indexOf(fixture);
      const next = (current + (dx < 0 ? 1 : -1) + sceneOrder.length) % sceneOrder.length;
      loadFixture(sceneOrder[next]);
    };
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [demoMode, fixture, loadFixture]);

  return (
    <div className="app-shell">
      <SceneRenderer />
      {demoMode ? <>
        <button className="dev-toggle tech micro" type="button" onClick={() => setControllerOpen(true)}>CTRL</button>
        <ControllerPanel open={controllerOpen} onClose={() => setControllerOpen(false)} />
        <IRDrawer open={irOpen} onClose={() => setIrOpen(false)} />
      </> : <RuntimeIntegration />}
    </div>
  );
}
