import {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useState,
} from "react";
import { controllerReducer, createInitialState } from "./reducer";
import type { ControllerAction, ControllerState, FixtureName } from "./types";
import { fixtures } from "../fixtures/scenes";

// The isolated voice transport registers itself here so the on-screen Damocles
// presence can drive a call turn. It is absent in demo mode, where the presence
// only toggles a visual listening state.
export interface VoiceRuntime {
  // Start a call turn, or finish the active one (the transport owns the
  // start/send/retry policy behind this single affordance).
  toggleTurn: () => void;
  // Send a typed turn to the agent on the line. False means it was not put
  // on the wire (the line is down) and the caller should keep the text.
  sendText: (text: string) => boolean;
}

interface ControllerContextValue {
  state: ControllerState;
  dispatch: Dispatch<ControllerAction>;
  run: (actions: readonly ControllerAction[]) => void;
  loadFixture: (name: FixtureName) => void;
  fixture: FixtureName;
  transcriptOpen: boolean;
  setTranscriptOpen: (open: boolean) => void;
  voiceRuntime: VoiceRuntime | null;
  registerVoiceRuntime: (runtime: VoiceRuntime | null) => void;
}

const ControllerContext = createContext<ControllerContextValue | null>(null);

export function ControllerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    controllerReducer,
    undefined,
    createInitialState,
  );
  const [fixture, setFixture] = useState<FixtureName>("idle");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntime | null>(null);

  const registerVoiceRuntime = useCallback((runtime: VoiceRuntime | null) => {
    setVoiceRuntime(runtime);
  }, []);

  const run = useCallback((actions: readonly ControllerAction[]) => {
    for (const action of actions) dispatch(action);
  }, []);

  const loadFixture = useCallback((name: FixtureName) => {
    dispatch({ op: "clear" });
    setTranscriptOpen(false);
    setFixture(name);
    for (const action of fixtures[name]) dispatch(action);
  }, []);

  const value = useMemo(
    () => ({
      state,
      dispatch,
      run,
      loadFixture,
      fixture,
      transcriptOpen,
      setTranscriptOpen,
      voiceRuntime,
      registerVoiceRuntime,
    }),
    [
      state,
      run,
      loadFixture,
      fixture,
      transcriptOpen,
      voiceRuntime,
      registerVoiceRuntime,
    ],
  );

  return (
    <ControllerContext.Provider value={value}>
      {children}
    </ControllerContext.Provider>
  );
}

export function useController(): ControllerContextValue {
  const value = useContext(ControllerContext);
  if (!value)
    throw new Error("useController must be used inside ControllerProvider");
  return value;
}
