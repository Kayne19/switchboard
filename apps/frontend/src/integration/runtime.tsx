// Connects the page's call runtime (`runtime/callRuntime.ts`) to the scene
// controller: backend messages become scene actions, runtime state drives the
// listening presence, and the rendered scene goes back to the backend as
// screen-state reports.

import { useCallback, useEffect, useRef, useState } from "react";
import { deriveScreenState } from "../app/sceneModel";
import { interpretDisplayMessage } from "../app/displayMessage";
import { planReportDispatch, shouldClearRejectionOnSend } from "../app/reportDispatch";
import { useController } from "../controller/context";
import type { MessageData, ScreenStateReport, SpokenLine } from "../controller/types";
import { RUNTIME_CONVERSATION_ID, RUNTIME_LINE_ERROR_ID } from "../controller/types";
import { two } from "../primitives/timeLabels";
import type { ServerMessage, TranscriptEntry } from "../protocol";
import {
  CallRuntime,
  INITIAL_RUNTIME_STATE,
  type RuntimeState,
} from "../runtime/callRuntime";
import type { HeardLine } from "../runtime/spokenLines";

interface TranscriptLine {
  speaker: string;
  text: string;
  id?: string;
  /** Whether this agent line was voiced to the caller. */
  voiced?: boolean;
  /** The route that spoke: `operator` or a project id. */
  agent?: string;
}

function normalizeHistory(entries: TranscriptEntry[]): TranscriptLine[] {
  return entries.flatMap((entry) =>
    entry.text
      ? [
          {
            speaker: entry.role === "caller" ? "CALLER" : "DAMOCLES",
            text: entry.text,
            id: entry.id || undefined,
            voiced: entry.voiced,
            agent: entry.role === "caller" ? undefined : entry.route || undefined,
          },
        ]
      : [],
  );
}

/** How many heard lines the live response keeps for scrollback (#113). */
const SPOKEN_LOG_LIMIT = 50;

/** A heard line in the live response's log, with where it falls in it. */
interface LoggedLine extends SpokenLine {
  order: number;
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
  const transportReadyRef = useRef(false);
  const generationRef = useRef(0);
  const pendingReportRef = useRef<ScreenStateReport | null>(null);
  const inFlightReportRef = useRef<ScreenStateReport | null>(null);
  const appliedSeqRef = useRef(0);
  const pendingRejectionRef = useRef<{ seq: number; reason: string } | null>(null);
  const handleServerRef = useRef<(message: ServerMessage) => void>(() => {});
  const handleStateRef = useRef<(runtimeState: RuntimeState) => void>(() => {});
  const handleHeardRef = useRef<(line: HeardLine) => void>(() => {});
  // The lines the caller heard, oldest first, for the live response's log;
  // the last is the one being heard.
  const spokenLogRef = useRef<LoggedLine[]>([]);
  const nextLineIdRef = useRef(0);
  // The error text last put on screen, so one failure is not said twice.
  const shownStatusRef = useRef("");
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

  // An ack answers a report this connection sent after its epoch; one before
  // the epoch (or after the line went down) answers nothing.
  const handleScreenStateAck = useCallback(() => {
    if (!transportReadyRef.current) return;
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
      const responseCount = transcriptRef.current.filter((entry) => entry.speaker === "DAMOCLES").length;
      const message: MessageData = {
        context:
          runtime.route === "operator"
            ? "OPERATOR LINE"
            : `PROJECT / ${runtime.route.toUpperCase()}`,
        tag: "CURRENT RESPONSE / LIVE",
        caption: `VOICE / ${two(Math.max(1, responseCount))}`,
        // No response yet means no segments: the conversation scene shows
        // its own open-line prompt, and a content rail shows no live card.
        segments: currentResponseRef.current ? [{ text: currentResponseRef.current }] : [],
        lines: spokenLogRef.current.map(({ id, text }) => ({ id, text })),
        channel: { name: "VOICE" },
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
    [dispatch, runtime.route],
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
          // The transcript and the last response belong to the call, so a
          // handoff keeps them on screen; `epoch_reset` drops only what the
          // old leg put there. A reconnect is followed by `history`, which
          // replaces the transcript with the server's.
          generationRef.current = message.generation;
          transportReadyRef.current = true;
          inFlightReportRef.current = null;
          pendingReportRef.current = null;
          dispatch({ op: "epoch_reset" });
          break;
        }
        case "history": {
          transcriptRef.current = normalizeHistory(message.entries);
          // The log restarts from the lines the history says were voiced.
          spokenLogRef.current = transcriptRef.current
            .filter((entry) => entry.voiced)
            .slice(-SPOKEN_LOG_LIMIT)
            .map((entry) => ({
              id: nextLineIdRef.current++,
              text: entry.text,
              order: Number.NEGATIVE_INFINITY,
            }));
          currentResponseRef.current = spokenLogRef.current.at(-1)?.text ?? "";
          if (transcriptRef.current.length > 0) {
            showConversation();
          } else {
            // The server has no call to show, so neither does the page.
            dispatch({ op: "runtime_hide", id: RUNTIME_CONVERSATION_ID });
          }
          break;
        }
        case "transcript": {
          const body = message.text;
          if (!body) break;
          appendTranscript({
            speaker: "CALLER",
            text: body,
            id: message.id || undefined,
          });
          showConversation();
          break;
        }
        case "spoken": {
          // The line goes into the transcript now; the live response shows
          // it when its audio starts (`handleHeardRef`).
          const body = message.entry.text;
          if (!body) break;
          appendTranscript({
            speaker: "DAMOCLES",
            text: body,
            id: message.entry.id || undefined,
            voiced: true,
            agent: message.entry.route || undefined,
          });
          showConversation();
          break;
        }
        case "reply": {
          // The turn is over, so nothing it started is still running, even
          // should an end have gone missing.
          dispatch({ op: "runtime_activity", activity: null, at: Date.now() });
          const body = message.text || "(No spoken response.)";
          appendTranscript({
            speaker: "DAMOCLES",
            text: body,
            voiced: message.voiced,
            agent: message.route || undefined,
          });
          // A voiced reply reaches the live response when its audio starts
          // (`handleHeardRef`). An unvoiced written reply belongs in the
          // transcript drawer only, and the live response stays on the last
          // line that was actually spoken.
          showConversation();
          break;
        }
        case "thinking":
          // A new turn: nothing an earlier one started is still running.
          dispatch({ op: "runtime_activity", activity: null });
          dispatch({ op: "listen", on: false });
          break;
        case "activity": {
          // A tool call is status, not explanation. It used to go out as
          // speech, so every call flashed its tool text over what Damocles
          // had said and then left the bare leg label behind; it now goes to
          // the activity surface and never touches speech.
          // The reducer counts the calls under way, so a burst of them --
          // twenty parallel reads -- reads as twenty, and an end retires
          // one call of its tool rather than the panel.
          const tool = message.tool;
          if (message.state === "start") {
            dispatch({
              op: "runtime_activity",
              activity: { label: message.label, tool, detail: message.detail },
              at: Date.now(),
            });
          } else if (message.state === "end") {
            dispatch({ op: "runtime_activity_end", tool, at: Date.now() });
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
          const target = message.target;
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
          const body = message.message || "The line reported an error.";
          dispatch({ op: "runtime_say", target: RUNTIME_LINE_ERROR_ID, text: body });
          break;
        }
        case "agents_state":
          // Agent state is consumed by the station surfaces. The call runtime
          // only transports it; it must never turn background status into
          // caller speech.
          break;
        case "routing_unavailable":
          // CallRuntime shows this as a page status error. Do not put it on
          // the conversation surface or send it through speech synthesis.
          break;
      }
    };

    // A spoken line's audio started: it is the line being heard (#112), and
    // it joins the log (#113). A line whose text came after a later line was
    // already heard goes into the log before that line, and the live
    // response stays on the later one.
    handleHeardRef.current = (line: HeardLine) => {
      const log = spokenLogRef.current;
      let at = log.length;
      while (at > 0 && log[at - 1].order > line.order) at -= 1;
      const entry = { id: nextLineIdRef.current++, text: line.text, order: line.order };
      spokenLogRef.current = [...log.slice(0, at), entry, ...log.slice(at)].slice(
        -SPOKEN_LOG_LIMIT,
      );
      if (at < log.length) {
        showConversation();
        return;
      }
      currentResponseRef.current = line.text;
      showConversation(line.text);
      dispatch({
        op: "runtime_say",
        target: RUNTIME_CONVERSATION_ID,
        text: line.text,
      });
    };

    handleStateRef.current = (runtimeState: RuntimeState) => {
      if (!runtimeState.connected) transportReadyRef.current = false;
      setRuntime(runtimeState);
      // The runtime reports a failure it cannot recover from -- no
      // microphone, a browser that cannot record, a recorder that stopped --
      // as status text with the error flag set. The page rendered neither
      // field, so on a browser where capture fails the caller tapped Damocles
      // and nothing at all happened, on screen or anywhere else. An error
      // goes on screen the way a server `error` does, as a failure of the
      // line; ordinary status text -- the idle line, a turn under way --
      // never does. It leaves the screen when the runtime says the failure
      // is over: a status reported without the flag.
      if (runtimeState.statusError) {
        if (runtimeState.status !== shownStatusRef.current) {
          shownStatusRef.current = runtimeState.status;
          dispatch({ op: "runtime_say", target: RUNTIME_LINE_ERROR_ID, text: runtimeState.status });
        }
      } else if (shownStatusRef.current) {
        shownStatusRef.current = "";
        dispatch({ op: "runtime_unsay", target: RUNTIME_LINE_ERROR_ID });
      }
      dispatch({
        op: "listen",
        on: Boolean(
          runtimeState.recording || runtimeState.handsFree || runtimeState.speaking,
        ),
      });
    };
  }, [dispatch, handleScreenStateAck, showConversation]);

  // The conversation names the leg it is on and stays mounted through a
  // handoff, so a new route relabels it at once instead of leaving the old
  // name up until the new agent's first words.
  const conversationShownRef = useRef(false);
  conversationShownRef.current = Boolean(state.runtimeObjects[RUNTIME_CONVERSATION_ID]);
  useEffect(() => {
    if (conversationShownRef.current) showConversation();
  }, [showConversation]);

  useEffect(() => {
    const socketUrl = backendSocketUrl();
    if (!socketUrl) return;
    const runtimeForPage = new CallRuntime({
      socketUrl,
      onState: (runtimeState) => handleStateRef.current(runtimeState),
      onServer: (message) => handleServerRef.current(message),
      onHeard: (line) => handleHeardRef.current(line),
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

  // The page's controls on the call: the Damocles presence starts a turn,
  // sends the one being recorded, or forces a reconnect when the line is
  // down, and the corner stack's MODE switches hands-free listening.
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
      getVoiceLevel: () => callRuntime.currentVoiceLevel,
      // The corner stack's MODE reads this and switches it (#180). The
      // runtime owns the policy: it loads the wake-word detector on the
      // first switch and refuses one while the line is down.
      handsFree: runtime.handsFree,
      toggleHandsFree: () => callRuntime.toggleHandsFree(),
    });
    return () => registerVoiceRuntime(null);
  }, [callRuntime, registerVoiceRuntime, runtime.connected, runtime.handsFree, runtime.recording]);

  return null;
}
