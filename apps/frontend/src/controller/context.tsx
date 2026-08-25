import { createContext, type Dispatch, type ReactNode, useCallback, useContext, useMemo, useReducer, useState } from 'react';
import { controllerReducer, createInitialState } from './reducer';
import type { ControllerAction, ControllerState, FixtureName } from './types';
import { fixtures } from '../fixtures/scenes';

interface ControllerContextValue {
  state: ControllerState;
  dispatch: Dispatch<ControllerAction>;
  run: (actions: readonly ControllerAction[]) => void;
  loadFixture: (name: FixtureName) => void;
  fixture: FixtureName;
  transcriptOpen: boolean;
  setTranscriptOpen: (open: boolean) => void;
}

const ControllerContext = createContext<ControllerContextValue | null>(null);

export function ControllerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(controllerReducer, undefined, createInitialState);
  const [fixture, setFixture] = useState<FixtureName>('idle');
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const run = useCallback((actions: readonly ControllerAction[]) => {
    for (const action of actions) dispatch(action);
  }, []);

  const loadFixture = useCallback((name: FixtureName) => {
    dispatch({ op: 'clear' });
    setTranscriptOpen(false);
    setFixture(name);
    for (const action of fixtures[name]) dispatch(action);
  }, []);

  const value = useMemo(
    () => ({ state, dispatch, run, loadFixture, fixture, transcriptOpen, setTranscriptOpen }),
    [state, run, loadFixture, fixture, transcriptOpen],
  );

  return <ControllerContext.Provider value={value}>{children}</ControllerContext.Provider>;
}

export function useController(): ControllerContextValue {
  const value = useContext(ControllerContext);
  if (!value) throw new Error('useController must be used inside ControllerProvider');
  return value;
}
