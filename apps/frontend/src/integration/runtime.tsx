import { useCallback, useEffect, useRef, useState } from "react";
import { useController } from "../controller/context";
import type { ControllerAction, MessageData } from "../controller/types";
import { validateControllerAction } from "../controller/validation";

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

type ServerMessage = Record<string, unknown> & { type?: string };

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
    return body ? [{ speaker: item.role === "caller" ? "CALLER" : "DAMOCLES", text: body, id: text(item.id) || undefined }] : [];
  });
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return Boolean(value && typeof value === "object");
}

export function RuntimeIntegration() {
  const { dispatch, registerVoiceRuntime } = useController();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const currentResponseRef = useRef("");
  const visualActionRef = useRef<ControllerAction | null>(null);
  const visualActiveRef = useRef(false);
  const [runtime, setRuntime] = useState<RuntimeState>(initialRuntime);

  const command = useCallback((name: string, value?: string) => {
    frameRef.current?.contentWindow?.postMessage(
      { source: V17_SOURCE, command: name, value },
      window.location.origin,
    );
  }, []);

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
      visualActiveRef.current = false;
      dispatch({ op: "hide", id: "live-visual" });
      dispatch({ op: "hide", id: "live-progress" });
      dispatch({
        op: "show",
        id: "conversation",
        type: "message",
        role: "primary",
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
        case "epoch":
          transcriptRef.current = [];
          currentResponseRef.current = "";
          visualActionRef.current = null;
          visualActiveRef.current = false;
          dispatch({ op: "clear" });
          break;
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
          if (!visualActiveRef.current) showConversation();
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
          if (visualActiveRef.current)
            dispatch({ op: "say", target: "live-visual", text: body });
          else showConversation(body);
          break;
        }
        case "reply": {
          const body = text(message.text) || "(No spoken response.)";
          appendTranscript({ speaker: "DAMOCLES", text: body });
          currentResponseRef.current = body;
          if (visualActiveRef.current)
            dispatch({ op: "say", target: "live-visual", text: body });
          else showConversation(body);
          break;
        }
        case "thinking":
          dispatch({ op: "listen", on: false });
          break;
        case "activity": {
          const detail = [text(message.label), text(message.detail)]
            .filter(Boolean)
            .join(" / ");
          if (detail) dispatch({ op: "say", text: detail });
          break;
        }
        case "display": {
          const result = validateControllerAction(message.action);
          if (result.ok) dispatch(result.action);
          break;
        }
        case "view": {
          const target = text(message.target);
          if (target === "comms") {
            showConversation();
          } else if (
            (target === "visual" || target === "theater") &&
            visualActionRef.current
          ) {
            visualActiveRef.current = true;
            dispatch({ op: "hide", id: "conversation" });
            dispatch(visualActionRef.current);
            dispatch({
              op: "focus",
              id: target === "theater" ? "live-visual" : null,
            });
          } else {
            dispatch({ op: "focus", id: null });
          }
          break;
        }
        case "error": {
          const body = text(message.message) || "The line reported an error.";
          if (currentResponseRef.current) dispatch({ op: "say", text: body });
          else showConversation(body);
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
        const state = packet.payload;
        setRuntime((current) => ({ ...current, ...state }));
        dispatch({
          op: "listen",
          on: Boolean(state.recording || state.handsFree),
        });
      } else if (
        packet.kind === "server" &&
        packet.payload &&
        typeof packet.payload === "object"
      ) {
        handleServer(packet.payload as ServerMessage);
      } else if (packet.kind === "ready") {
        command("state");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [command, dispatch, showConversation]);

  // The on-screen Damocles presence is the only call affordance in the approved
  // design, so register the transport's turn control for it to drive. The
  // transport owns the start/send/retry policy behind the single toggle.
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

  // No visible chrome: the isolated voice runtime lives in a hidden iframe and
  // reaches the UI only through the controller (see handleServer above).
  return (
    <iframe
      ref={frameRef}
      className="runtime-frame"
      src={import.meta.env.DEV ? "about:blank" : "/legacy/index.html?runtime=1"}
      title="Switchboard voice runtime"
      allow="microphone; autoplay"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
