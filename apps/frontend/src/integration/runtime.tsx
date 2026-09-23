import { useCallback, useEffect, useRef, useState } from "react";
import { deriveScreenState } from "../app/sceneModel";
import { interpretDisplayMessage } from "../app/displayMessage";
import { useController } from "../controller/context";
import type { MessageData, ScreenStateReport } from "../controller/types";
import { RUNTIME_CONVERSATION_ID } from "../controller/types";

const LEGACY_SOURCE = "switchboard-legacy-runtime";
const V17_SOURCE = "switchboard-v17";

interface SelectOption {
  value: string;
  label: string;
}

interface RuntimeState {
  connected: boolean;
  recording: boolean;
  status: string;
  handsFree: boolean;
  handsFreeStatus: string;
  handsFreeLease: string;
  route: string;
  routes: SelectOption[];
  model: string;
  models: SelectOption[];
  thinking: string;
  thinkingLevels: SelectOption[];
  onProject: boolean;
  modelDisabled: boolean;
  thinkingDisabled: boolean;
}

interface TranscriptLine {
  speaker: string;
  text: string;
  id?: string;
}

type ServerMessage = Record<string, unknown> & { type?: string; seq?: number };

const initialRuntime: RuntimeState = {
  connected: false,
  recording: false,
  status: "Connecting…",
  handsFree: false,
  handsFreeStatus: "Standby",
  handsFreeLease: "",
  route: "operator",
  routes: [{ value: "operator", label: "Operator" }],
  model: "",
  models: [],
  thinking: "",
  thinkingLevels: [],
  onProject: false,
  modelDisabled: true,
  thinkingDisabled: true,
};

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

function isRuntimeState(value: unknown): value is RuntimeState {
  return Boolean(value && typeof value === "object");
}

export function RuntimeIntegration() {
  const { state, dispatch, registerVoiceRuntime } = useController();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const currentResponseRef = useRef("");
  const iframeReadyRef = useRef(false);
  const generationRef = useRef(0);
  const pendingReportRef = useRef<ScreenStateReport | null>(null);
  const inFlightReportRef = useRef<ScreenStateReport | null>(null);
  const appliedSeqRef = useRef(0);
  const pendingRejectionRef = useRef<{ seq: number; reason: string } | null>(null);
  const [reportNonce, setReportNonce] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeState>(initialRuntime);

  const command = useCallback((name: string, value?: unknown) => {
    frameRef.current?.contentWindow?.postMessage(
      { source: V17_SOURCE, command: name, value },
      window.location.origin,
    );
  }, []);

  const sendReport = useCallback(
    (report: ScreenStateReport) => {
      inFlightReportRef.current = report;
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

    const handleServer = (message: ServerMessage) => {
      switch (message.type) {
        case "epoch": {
          transcriptRef.current = [];
          currentResponseRef.current = "";
          generationRef.current =
            typeof message.generation === "number" ? message.generation : 0;
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

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const packet = event.data as {
        source?: string;
        kind?: string;
        payload?: unknown;
      };
      if (packet?.source !== LEGACY_SOURCE) return;
      if (packet.kind === "state" && isRuntimeState(packet.payload)) {
        const runtimeState = packet.payload;
        setRuntime((current) => ({ ...current, ...runtimeState }));
        dispatch({
          op: "listen",
          on: Boolean(runtimeState.recording || runtimeState.handsFree),
        });
      } else if (
        packet.kind === "server" &&
        packet.payload &&
        typeof packet.payload === "object"
      ) {
        handleServer(packet.payload as ServerMessage);
      } else if (packet.kind === "ready") {
        iframeReadyRef.current = true;
        command("state");
        if (pendingReportRef.current && !inFlightReportRef.current) {
          const report = pendingReportRef.current;
          pendingReportRef.current = null;
          sendReport(report);
        }
      } else if (packet.kind === "screen_state_ack") {
        handleScreenStateAck();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [command, dispatch, handleScreenStateAck, sendReport, showConversation]);

  // Derive screen state and queue/send across the bridge
  useEffect(() => {
    const report = deriveScreenState(state, generationRef.current);
    report.applied_seq = appliedSeqRef.current;
    if (pendingRejectionRef.current) {
      report.rejected = pendingRejectionRef.current;
      pendingRejectionRef.current = null;
    }
    const serialized = JSON.stringify(report);
    const inFlightSerialized = inFlightReportRef.current
      ? JSON.stringify(inFlightReportRef.current)
      : null;

    if (serialized === inFlightSerialized) {
      return;
    }

    if (!iframeReadyRef.current) {
      pendingReportRef.current = report;
      return;
    }

    if (inFlightReportRef.current) {
      pendingReportRef.current = report;
      return;
    }

    sendReport(report);
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
