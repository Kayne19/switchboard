import { useCallback, useEffect, useRef, useState } from "react";
import { deriveScreenState } from "../app/sceneModel";
import { interpretDisplayMessage } from "../app/displayMessage";
import { planReportDispatch, shouldClearRejectionOnSend } from "../app/reportDispatch";
import { useController } from "../controller/context";
import type { MessageData, ScreenStateReport } from "../controller/types";
import { RUNTIME_CONVERSATION_ID } from "../controller/types";
import {
  CallRuntime,
  INITIAL_RUNTIME_STATE,
  type RuntimeState,
} from "../runtime/callRuntime";

const LEGACY_SOURCE = "switchboard-legacy-runtime";
const V17_SOURCE = "switchboard-v17";

interface TranscriptLine {
  speaker: string;
  text: string;
  id?: string;
}

type ServerMessage = Record<string, unknown> & { type?: string; seq?: number };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeHistory(raw: unknown): TranscriptLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const body = text(item.text);
    return body
      ? [
          {
            speaker: item.role === "caller" ? "CALLER" : "DAMOCLES",
            text: body,
            id: text(item.id) || undefined,
          },
        ]
      : [];
  });
}

function isRuntimeState(value: unknown): value is Partial<RuntimeState> {
  return Boolean(value && typeof value === "object");
}

// The native runtime is the default. `?legacy` falls back to the iframe
// bridge for one release while the native path is proven in use.
function nativeRuntimeRequested(): boolean {
  return !new URLSearchParams(window.location.search).has("legacy");
}

// `?ws=` points the page at another backend. The dev server has no backend of
// its own, so without one the native runtime stays down there.
function backendSocketUrl(): string | null {
  const wsParam = new URLSearchParams(window.location.search).get("ws");
  if (wsParam) return wsParam;
  if (import.meta.env.DEV) return null;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

// The iframe bridge's command vocabulary, served by the native runtime.
function runNativeCommand(
  runtime: CallRuntime | null,
  name: string,
  value: unknown,
): void {
  if (!runtime) return;
  switch (name) {
    case "talk":
      runtime.talk();
      break;
    case "send":
      runtime.send();
      break;
    case "cancel":
      runtime.cancel();
      break;
    case "retry":
      runtime.retry();
      break;
    case "hands-free":
      runtime.toggleHandsFree();
      break;
    case "hangup":
      void runtime.hangup();
      break;
    case "route":
      if (typeof value === "string") runtime.selectRoute(value);
      break;
    case "model":
      if (typeof value === "string") runtime.selectModel(value);
      break;
    case "thinking":
      if (typeof value === "string") runtime.selectThinking(value);
      break;
    case "screen_state":
      if (value && typeof value === "object")
        runtime.sendScreenState(value as ScreenStateReport);
      break;
  }
}

export function RuntimeIntegration() {
  const { state, dispatch, registerVoiceRuntime } = useController();
  const [native] = useState(nativeRuntimeRequested);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nativeRuntimeRef = useRef<CallRuntime | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const currentResponseRef = useRef("");
  const transportReadyRef = useRef(false);
  const generationRef = useRef(0);
  const pendingReportRef = useRef<ScreenStateReport | null>(null);
  const inFlightReportRef = useRef<ScreenStateReport | null>(null);
  const appliedSeqRef = useRef(0);
  const pendingRejectionRef = useRef<{ seq: number; reason: string } | null>(null);
  const handleServerRef = useRef<(message: ServerMessage) => void>(() => {});
  const handleStateRef = useRef<(runtimeState: Partial<RuntimeState>) => void>(
    () => {},
  );
  const [reportNonce, setReportNonce] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeState>(INITIAL_RUNTIME_STATE);

  const command = useCallback(
    (name: string, value?: unknown) => {
      if (native) {
        runNativeCommand(nativeRuntimeRef.current, name, value);
        return;
      }
      frameRef.current?.contentWindow?.postMessage(
        { source: V17_SOURCE, command: name, value },
        window.location.origin,
      );
    },
    [native],
  );

  const sendReport = useCallback(
    (report: ScreenStateReport) => {
      inFlightReportRef.current = report;
      if (shouldClearRejectionOnSend(report, pendingRejectionRef.current)) {
        pendingRejectionRef.current = null;
      }
      command("screen_state", report);
    },
    [command],
  );

  const handleScreenStateAck = useCallback(() => {
    inFlightReportRef.current = null;
    if (pendingReportRef.current) {
      const next = pendingReportRef.current;
      pendingReportRef.current = null;
      sendReport(next);
    }
  }, [sendReport]);

  const showConversation = useCallback(
    (response?: string) => {
      if (response !== undefined) currentResponseRef.current = response;
      const message: MessageData = {
        context:
          runtime.route === "operator"
            ? "OPERATOR LINE"
            : `PROJECT / ${runtime.route.toUpperCase()}`,
        tag: "CURRENT RESPONSE / LIVE",
        segments: [
          {
            text: currentResponseRef.current || "Line open. Speak when ready.",
          },
        ],
        channel: {
          name: "VOICE",
          mode: runtime.handsFree ? "HANDS-FREE" : "PUSH-TO-TALK",
        },
        transcript: transcriptRef.current,
      };
      dispatch({
        op: "runtime_show",
        id: RUNTIME_CONVERSATION_ID,
        type: "message",
        role: "secondary",
        data: message,
      });
    },
    [dispatch, runtime.handsFree, runtime.route],
  );

  // Both transports deliver into these two handlers.
  useEffect(() => {
    const appendTranscript = (line: TranscriptLine) => {
      const existing = line.id
        ? transcriptRef.current.findIndex((entry) => entry.id === line.id)
        : -1;
      if (existing >= 0) {
        transcriptRef.current = transcriptRef.current.map((entry, index) =>
          index === existing ? line : entry,
        );
      } else {
        transcriptRef.current = [...transcriptRef.current, line].slice(-200);
      }
    };

    handleServerRef.current = (message: ServerMessage) => {
      switch (message.type) {
        case "epoch": {
          transcriptRef.current = [];
          currentResponseRef.current = "";
          generationRef.current =
            typeof message.generation === "number" ? message.generation : 0;
          transportReadyRef.current = true;
          inFlightReportRef.current = null;
          pendingReportRef.current = null;
          dispatch({ op: "epoch_reset" });
          break;
        }
        case "history": {
          transcriptRef.current = normalizeHistory(message.entries);
          const latest = [...transcriptRef.current]
            .reverse()
            .find((entry) => entry.speaker === "DAMOCLES");
          currentResponseRef.current = latest?.text ?? "";
          if (transcriptRef.current.length > 0) showConversation();
          break;
        }
        case "transcript": {
          const body = text(message.text);
          if (!body) break;
          appendTranscript({
            speaker: "CALLER",
            text: body,
            id: text(message.id) || undefined,
          });
          showConversation();
          break;
        }
        case "spoken": {
          const entry = message.entry;
          if (!entry || typeof entry !== "object") break;
          const item = entry as Record<string, unknown>;
          const body = text(item.text);
          if (!body) break;
          appendTranscript({
            speaker: "DAMOCLES",
            text: body,
            id: text(item.id) || undefined,
          });
          currentResponseRef.current = body;
          showConversation(body);
          dispatch({
            op: "runtime_say",
            target: RUNTIME_CONVERSATION_ID,
            text: body,
          });
          break;
        }
        case "reply": {
          const body = text(message.text) || "(No spoken response.)";
          appendTranscript({ speaker: "DAMOCLES", text: body });
          currentResponseRef.current = body;
          showConversation(body);
          dispatch({
            op: "runtime_say",
            target: RUNTIME_CONVERSATION_ID,
            text: body,
          });
          break;
        }
        case "thinking":
          dispatch({ op: "listen", on: false });
          break;
        case "activity": {
          const detail = [text(message.label), text(message.detail)]
            .filter(Boolean)
            .join(" / ");
          if (detail) dispatch({ op: "runtime_say", text: detail });
          break;
        }
        case "display": {
          const { result, seq } = interpretDisplayMessage(message);
          if (result.ok) {
            dispatch(result.action);
            if (seq !== undefined) {
              appliedSeqRef.current = Math.max(appliedSeqRef.current, seq);
            }
          } else {
            if (seq !== undefined) {
              pendingRejectionRef.current = { seq, reason: result.error };
            }
            setReportNonce((n) => n + 1);
          }
          break;
        }
        case "view": {
          const target = text(message.target);
          if (target === "comms") {
            showConversation();
          }
          dispatch({ op: "set_view", view: target });
          break;
        }
        case "screen_state_ack": {
          handleScreenStateAck();
          break;
        }
        case "error": {
          const body = text(message.message) || "The line reported an error.";
          dispatch({ op: "runtime_say", text: body });
          break;
        }
      }
    };

    handleStateRef.current = (runtimeState: Partial<RuntimeState>) => {
      if (!runtimeState.connected) transportReadyRef.current = false;
      setRuntime((current) => ({ ...current, ...runtimeState }));
      dispatch({
        op: "listen",
        on: Boolean(runtimeState.recording || runtimeState.handsFree),
      });
    };
  }, [dispatch, handleScreenStateAck, showConversation]);

  // Legacy transport: the hidden iframe owns the socket and posts to us.
  useEffect(() => {
    if (native) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const packet = event.data as {
        source?: string;
        kind?: string;
        payload?: unknown;
      };
      if (event.source !== frameRef.current?.contentWindow) return;
      if (packet?.source !== LEGACY_SOURCE) return;
      if (packet.kind === "state" && isRuntimeState(packet.payload)) {
        handleStateRef.current(packet.payload);
      } else if (
        packet.kind === "server" &&
        packet.payload &&
        typeof packet.payload === "object"
      ) {
        handleServerRef.current(packet.payload as ServerMessage);
      } else if (packet.kind === "ready") {
        command("bridge_ready");
        command("state");
      } else if (packet.kind === "screen_state_ack") {
        handleScreenStateAck();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [native, command, handleScreenStateAck]);

  // Native transport: this page owns the socket.
  useEffect(() => {
    if (!native) return;
    const socketUrl = backendSocketUrl();
    if (!socketUrl) return;
    const callRuntime = new CallRuntime({
      socketUrl,
      onState: (runtimeState) => handleStateRef.current(runtimeState),
      onServer: (message) => handleServerRef.current(message),
      document,
      window,
    });
    nativeRuntimeRef.current = callRuntime;
    callRuntime.start();
    return () => {
      callRuntime.dispose();
      if (nativeRuntimeRef.current === callRuntime)
        nativeRuntimeRef.current = null;
    };
  }, [native]);

  // Derive screen state and queue/send it over the transport.
  //
  // The rejection carried on `pendingRejectionRef` is merged into the
  // report by `planReportDispatch` but never cleared here -- only
  // `sendReport` clears it, and only when the report actually being sent
  // is the one that carries it (see `shouldClearRejectionOnSend`). That is
  // what lets the rejection survive any number of intervening effect runs
  // (unrelated state changes) while an earlier report is still in flight,
  // instead of being silently dropped by a later, rejection-less rebuild
  // that would otherwise overwrite the queue.
  useEffect(() => {
    const baseReport = deriveScreenState(state, generationRef.current);
    baseReport.applied_seq = appliedSeqRef.current;

    const action = planReportDispatch(baseReport, {
      inFlightReport: inFlightReportRef.current,
      transportReady: transportReadyRef.current,
      pendingRejection: pendingRejectionRef.current,
    });

    if (action.kind === "skip") {
      return;
    }
    if (action.kind === "queue") {
      pendingReportRef.current = action.report;
      return;
    }
    sendReport(action.report);
  }, [state, sendReport, reportNonce]);

  useEffect(() => {
    const toggleTurn = () => {
      if (!runtime.connected) {
        command("retry");
        return;
      }
      command(runtime.recording ? "send" : "talk");
    };
    registerVoiceRuntime({ toggleTurn });
    return () => registerVoiceRuntime(null);
  }, [command, registerVoiceRuntime, runtime.connected, runtime.recording]);

  if (native) return null;

  const wsParam =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("ws")
      : null;
  const iframeSrc = import.meta.env.DEV
    ? "about:blank"
    : `/legacy/index.html?runtime=1${wsParam ? `&ws=${encodeURIComponent(wsParam)}` : ""}`;

  return (
    <iframe
      ref={frameRef}
      className="runtime-frame"
      src={iframeSrc}
      title="Switchboard voice runtime"
      allow="microphone; autoplay"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
