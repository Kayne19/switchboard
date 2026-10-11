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
import type { SelectOption } from "../runtime/lineStatus";

/**
 * The line as the call runtime holds it (`RuntimeState` in
 * runtime/callRuntime.ts), and its controls: what the system view draws
 * (#277). The page draws these values and acts only through these calls;
 * the runtime owns the pickers' locks and the requests they post.
 */
export interface LineControls {
  /** Whether the socket is up; with it down nothing can be switched. */
  connected: boolean;
  route: string;
  /** Display name for whoever is on the line. */
  routeLabel: string;
  routes: SelectOption[];
  model: string;
  models: SelectOption[];
  /** Why the model picker is unavailable, when the catalog failed to load. */
  modelTitle: string;
  thinking: string;
  thinkingLevels: SelectOption[];
  onProject: boolean;
  routeDisabled: boolean;
  modelDisabled: boolean;
  thinkingDisabled: boolean;
  /** The runtime's status line, and whether it reports a failure. */
  status: string;
  statusError: boolean;
  selectRoute: (route: string) => void;
  selectModel: (model: string) => void;
  selectThinking: (level: string) => void;
  hangup: () => void;
}

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
  /** Current microphone or playback RMS, sampled by the indicator's RAF. */
  getVoiceLevel?: () => number | null;
  /**
   * Whether hands-free wake-word listening is on, as the transport reports
   * it. The page draws MODE from this (`ChannelStack`); it keeps no
   * listening state of its own.
   */
  handsFree: boolean;
  /** Switches between push-to-talk and hands-free listening (the transport owns the policy). */
  toggleHandsFree: () => void;
  /** The line and its controls, for the system view. */
  line: LineControls;
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
