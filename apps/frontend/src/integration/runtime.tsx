// Connects the page's call runtime (`runtime/callRuntime.ts`) to the scene
// controller: backend messages become scene actions, runtime state drives the
// listening presence, and the rendered scene goes back to the backend as
// screen-state reports.

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

// `?ws=` points the page at another backend. The dev server has no backend of
// its own, so without one the call runtime stays down there.
function backendSocketUrl(): string | null {
  const wsParam = new URLSearchParams(window.location.search).get("ws");
  if (wsParam) return wsParam;
  if (import.meta.env.DEV) return null;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

export function RuntimeIntegration() {
  const { state, dispatch, registerVoiceRuntime } = useController();
  const [callRuntime, setCallRuntime] = useState<CallRuntime | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const currentResponseRef = useRef("");
  const currentCaptionRef = useRef("");
  const transportReadyRef = useRef(false);
  const generationRef = useRef(0);
  const pendingReportRef = useRef<ScreenStateReport | null>(null);
  const inFlightReportRef = useRef<ScreenStateReport | null>(null);
  const appliedSeqRef = useRef(0);
  const pendingRejectionRef = useRef<{ seq: number; reason: string } | null>(null);
  const handleServerRef = useRef<(message: ServerMessage) => void>(() => {});
  const activityToolRef = useRef<string | null>(null);
  activityToolRef.current = state.activity?.tool ?? null;
  const handleStateRef = useRef<(runtimeState: RuntimeState) => void>(() => {});
  const [reportNonce, setReportNonce] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeState>(INITIAL_RUNTIME_STATE);

  // A report the socket could not carry waits as the pending one, and the
  // rejection it carries stays pending with it.
  const sendReport = useCallback(
    (report: ScreenStateReport) => {
      if (!callRuntime?.sendScreenState(report)) {
        pendingReportRef.current = report;
        return;
      }
      inFlightReportRef.current = report;
      if (shouldClearRejectionOnSend(report, pendingRejectionRef.current)) {
        pendingRejectionRef.current = null;
      }
    },
    [callRuntime],
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
    (response?: string, caption?: string) => {
      if (response !== undefined) currentResponseRef.current = response;
      if (caption) currentCaptionRef.current = caption;
      const responseCount = transcriptRef.current.filter((entry) => entry.speaker === "DAMOCLES").length;
      const message: MessageData = {
        context:
          runtime.route === "operator"
            ? "OPERATOR LINE"
            : `PROJECT / ${runtime.route.toUpperCase()}`,
        tag: "CURRENT RESPONSE / LIVE",
        caption: currentCaptionRef.current || `VOICE / ${String(Math.max(1, responseCount)).padStart(2, "0")}`,
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

  // The runtime is created once; these handlers are replaced as the scene
  // callbacks they close over change.
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
          currentCaptionRef.current = "";
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
          showConversation(body, text(item.caption) || text(message.caption));
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
          showConversation(body, text(message.caption));
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
          // A tool call is status, not explanation. It used to go out as
          // speech, so every call flashed its tool text over what Damocles
          // had said and then left the bare leg label behind; it now goes to
          // the activity surface and never touches speech.
          const tool = text(message.tool);
          if (message.state === "start") {
            dispatch({
              op: "runtime_activity",
              activity: { label: text(message.label), tool, detail: text(message.detail) },
            });
          } else if (message.state === "end" && activityToolRef.current === tool) {
            dispatch({ op: "runtime_activity", activity: null });
          }
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

    handleStateRef.current = (runtimeState: RuntimeState) => {
      if (!runtimeState.connected) transportReadyRef.current = false;
      setRuntime(runtimeState);
      dispatch({
        op: "listen",
        on: Boolean(runtimeState.recording || runtimeState.handsFree),
      });
    };
  }, [dispatch, handleScreenStateAck, showConversation]);

  useEffect(() => {
    const socketUrl = backendSocketUrl();
    if (!socketUrl) return;
    const runtimeForPage = new CallRuntime({
      socketUrl,
      onState: (runtimeState) => handleStateRef.current(runtimeState),
      onServer: (message) => handleServerRef.current(message),
      document,
      window,
    });
    runtimeForPage.start();
    setCallRuntime(runtimeForPage);
    return () => {
      runtimeForPage.dispose();
      setCallRuntime(null);
    };
  }, []);

  // Derive screen state and queue/send it over the socket.
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

  // The Damocles presence is the call's one control: it starts a turn, sends
  // the one being recorded, or forces a reconnect when the line is down.
  useEffect(() => {
    if (!callRuntime) return;
    const toggleTurn = () => {
      if (!runtime.connected) {
        callRuntime.retry();
        return;
      }
      if (runtime.recording) callRuntime.send();
      else callRuntime.talk();
    };
    registerVoiceRuntime({
      toggleTurn,
      sendText: (text) => callRuntime.sendText(text),
    });
    return () => registerVoiceRuntime(null);
  }, [callRuntime, registerVoiceRuntime, runtime.connected, runtime.recording]);

  return null;
}
