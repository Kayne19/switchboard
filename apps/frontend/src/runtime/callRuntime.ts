// The browser's side of a call: the backend WebSocket, the caller's voice on
// the way in, the agent's voice on the way out, and the line controls.
//
// This is the React app's own transport. It owns no DOM; it reports what it
// is doing through two callbacks -- `onState` for the call's runtime state and
// `onServer` for every decoded backend message -- and the React adapter
// (`integration/runtime.tsx`) turns those into scenes.
//
// Lifecycle: `start()` starts the socket's link (`callLink.ts`), which owns the
// socket, its keepalive and the reconnect, and tells this runtime when the
// line comes up and goes down. `dispose()` ends the link without reconnecting.

import {
  HandsFreeController,
  type Detectors,
  type HandsFreeControllerOptions,
  type HandsFreeStateDetail,
  type SpeechEndpointer,
  type WakeDetector,
} from "../hands_free";
import {
  clipHeader,
  postJson,
  screenStateMessage,
  sttChunkHeader,
  sttEndHeader,
  sttStartHeader,
  typedTurnMessage,
  type ServerMessage,
} from "../protocol";
import type { ScreenStateReport } from "../controller/types";
import { AudioPlayback } from "./audioPlayback";
import { selectVoiceLevel } from "./audioLevel";
import {
  follow,
  NO_EPOCH_YET,
  type CallIdentity,
  type IdentityMessage,
  type IdentityStep,
} from "./callIdentity";
import { CallLink } from "./callLink";
import { errorText } from "./errors";
import {
  lineStateFromStatus,
  OPERATOR_LINE,
  pickerAvailability,
  type LineState,
  type SelectOption,
} from "./lineStatus";
import { ClipOutbox, type Clip } from "./outbox";
import { PushToTalk, type PushToTalkOptions } from "./pushToTalk";
import { SpokenLines, type HeardLine } from "./spokenLines";

export const IDLE_TEXT = "Connected. Tap Talk and speak.";

export interface RuntimeState {
  connected: boolean;
  recording: boolean;
  speaking: boolean;
  voiceLevelAvailable: boolean;
  status: string;
  statusError: boolean;
  handsFree: boolean;
  handsFreeStatus: string;
  handsFreeLease: string;
  route: string;
  routeLabel: string;
  routes: SelectOption[];
  model: string;
  models: SelectOption[];
  modelTitle: string;
  thinking: string;
  thinkingLevels: SelectOption[];
  onProject: boolean;
  routeDisabled: boolean;
  modelDisabled: boolean;
  thinkingDisabled: boolean;
}

export const INITIAL_RUNTIME_STATE: RuntimeState = {
  connected: false,
  recording: false,
  speaking: false,
  voiceLevelAvailable: false,
  status: "Connecting…",
  statusError: false,
  handsFree: false,
  handsFreeStatus: "Standby",
  handsFreeLease: "",
  route: OPERATOR_LINE.route,
  routeLabel: OPERATOR_LINE.label,
  routes: OPERATOR_LINE.routes,
  model: OPERATOR_LINE.model,
  models: OPERATOR_LINE.models,
  modelTitle: "",
  thinking: OPERATOR_LINE.thinking,
  thinkingLevels: OPERATOR_LINE.thinkingLevels,
  onProject: false,
  routeDisabled: false,
  modelDisabled: true,
  thinkingDisabled: false,
};

/**
 * The page events that count as the gesture blocked audio is waiting for.
 * `click` is not enough on iOS (see `start`).
 */
const GESTURE_EVENTS = ["click", "pointerdown", "touchend", "keydown"] as const;

interface EventSource {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface CallRuntimeOptions {
  socketUrl: string;
  onState: (state: RuntimeState) => void;
  onServer: (message: ServerMessage) => void;
  /**
   * A spoken line has started to be heard: its audio's turn to play came.
   * Its text arrived earlier, through `onServer`, and is already in the
   * transcript.
   */
  onHeard?: (line: HeardLine) => void;
  createSocket?: (url: string) => WebSocket;
  postJson?: typeof postJson;
  player?: HTMLAudioElement;
  getUserMedia?: PushToTalkOptions["getUserMedia"];
  createRecorder?: PushToTalkOptions["createRecorder"];
  createAudioContext?: PushToTalkOptions["createAudioContext"];
  /** Loads the local wake-word detector the first time hands-free starts. */
  loadWakeDetector?: () => Promise<WakeDetector>;
  /** Loads the local Silero speech endpointer alongside it. */
  loadSpeechEndpointer?: () => Promise<SpeechEndpointer>;
  createHandsFree?: (options: HandsFreeControllerOptions) => HandsFreeController;
  /** Where page-level listeners go: gestures, visibility, and page exit. */
  document?: EventSource & { readonly visibilityState?: DocumentVisibilityState };
  window?: EventSource;
}

type LineControl = "route" | "model" | "thinking";

export class CallRuntime {
  private readonly options: CallRuntimeOptions;
  private readonly link: CallLink;
  private readonly postJson: typeof postJson;
  private readonly playback: AudioPlayback;
  private readonly spokenLines: SpokenLines;
  private readonly pushToTalk: PushToTalk;
  private readonly outbox = new ClipOutbox();
  private state: RuntimeState = { ...INITIAL_RUNTIME_STATE };
  private statePublishQueued = false;
  private line: LineState = OPERATOR_LINE;
  private clipSequence = 0;

  // Which call this page is on: the epoch, the candidate starting, and the
  // adoption waiting for its epoch (`callIdentity.ts`). Every take, clip,
  // typed turn and line control is stamped from it. `followIdentity` is its
  // only writer.
  private identity: CallIdentity = NO_EPOCH_YET;

  private lineRequestsPending = 0;
  private lineRequestChain: Promise<void> | null = null;
  // Bumped for a control whenever the server states the line afresh or a
  // newer request for it starts; a failure from an older request is then
  // stale and is not shown over the fresher state.
  private readonly lineRequestIds: Record<LineControl, number> = {
    route: 0,
    model: 0,
    thinking: 0,
  };
  private hangupPending = false;

  // Hands-free's whole lifecycle, from its first load to the follow-up
  // lease, is the controller's; the runtime only tells it what happened.
  private readonly handsFree: HandsFreeController;
  private callerVoiceLevel = 0;
  private agentVoiceLevel = 0;
  private callerLevelAvailable = false;
  private agentLevelAvailable = false;

  private readonly onDocumentGesture = (event: Event) =>
    this.playback.handleGesture(event?.target ?? null);
  private readonly onVisibilityChange = () => {
    if (this.options.document?.visibilityState === "hidden")
      this.handsFree.stop("hidden");
  };
  private readonly onPageHide = () => this.handsFree.stop("pagehide");

  constructor(options: CallRuntimeOptions) {
    this.options = options;
    this.link = new CallLink({
      url: options.socketUrl,
      createSocket: options.createSocket ?? ((url) => new WebSocket(url)),
      lineUp: () => this.lineUp(),
      lineDown: () => this.lineDown(),
      status: (text, error) => this.setStatus(text, error),
      message: (message, socket) => this.receive(message, socket),
      audio: (bytes) => this.playback.receiveAudioChunk(bytes),
    });
    this.postJson = options.postJson ?? postJson;
    this.spokenLines = new SpokenLines((line) => this.options.onHeard?.(line));
    this.playback = new AudioPlayback({
      player: options.player,
      idleText: IDLE_TEXT,
      onStatus: (text, error) => this.setStatus(text, error),
      onAudioLevel: (level) => {
        this.agentVoiceLevel = level;
        if (!this.agentLevelAvailable) {
          this.agentLevelAvailable = true;
          this.update({ voiceLevelAvailable: true });
        }
      },
      onChange: () => {
        // A caption waits for the audio that voices it, but not for audio
        // that is not coming: the caption clock is told whether playback is
        // sounding, and frees a waiting line when it is not (#189).
        this.spokenLines.playbackActive(this.playback.isPlaying);
        this.update({ speaking: this.playback.isPlaying });
        this.handsFree.playbackChanged();
      },
      onUtterance: (sequence) => this.spokenLines.reach(sequence),
    });
    this.pushToTalk = new PushToTalk({
      idleText: IDLE_TEXT,
      getUserMedia: options.getUserMedia,
      createRecorder: options.createRecorder,
      createAudioContext: options.createAudioContext,
      onAudioLevel: (level) => this.setCallerLevel(level),
      newClipId: () => this.newClipId(),
      context: () => ({
        epoch: this.identity.epoch,
        transferEra: this.identity.candidate,
        streamingSelected: this.link.streaming,
      }),
      openSocket: () => this.link.socket(),
      enqueue: (clip) => this.enqueueOutbox(clip),
      flush: () => this.flushOutbox(),
      onRecordingChange: (recording) => this.update({ recording }),
      onStatus: (text, error) => this.setStatus(text, error),
      onActive: (active) =>
        active
          ? this.handsFree.pauseForPtt()
          : this.handsFree.resumeAfterPtt(),
    });
    const handsFreeOptions: HandsFreeControllerOptions = {
      loadDetectors: () => loadDetectors(options),
      isSnapshotReady: () => this.link.ready,
      currentEpoch: () => this.identity.epoch,
      isPttActive: () => this.pushToTalk.isActive,
      isPlaybackDrained: () => this.playback.isDrained(),
      onClip: (audio, mime, epoch) => this.submitHandsFreeClip(audio, mime, epoch),
      onAudioLevel: (level) => this.setCallerLevel(level),
      onState: (detail) => this.renderHandsFreeState(detail),
    };
    this.handsFree = options.createHandsFree
      ? options.createHandsFree(handsFreeOptions)
      : new HandsFreeController(handsFreeOptions);
    this.applyLine();
  }

  get currentState(): RuntimeState {
    return { ...this.state };
  }

  get currentVoiceLevel(): number | null {
    if (this.state.speaking && !this.agentLevelAvailable) return null;
    if (!this.state.speaking && !this.callerLevelAvailable) return null;
    return selectVoiceLevel(
      this.callerVoiceLevel,
      this.agentVoiceLevel,
      this.state.speaking,
    );
  }

  start(): void {
    if (this.link.started) return;
    // Blocked audio waits for a gesture, and `click` alone does not find one
    // on an iPad: iOS Safari does not deliver a click through event
    // delegation for a tap on an ordinary element, so a tap on the page body
    // never reached `document` and the caller heard nothing however often
    // they tapped (#189). A pointer or touch on the page is a gesture for
    // `play()` just the same, and a key is one for a keyboard.
    for (const type of GESTURE_EVENTS) {
      this.options.document?.addEventListener(type, this.onDocumentGesture);
    }
    this.options.document?.addEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
    this.options.window?.addEventListener("pagehide", this.onPageHide);
    this.link.start();
    this.publishState();
  }

  dispose(): void {
    if (this.link.disposed) return;
    this.link.dispose();
    for (const type of GESTURE_EVENTS) {
      this.options.document?.removeEventListener(type, this.onDocumentGesture);
    }
    this.options.document?.removeEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
    this.options.window?.removeEventListener("pagehide", this.onPageHide);
    this.pushToTalk.stop(false);
    this.handsFree.stop("dispose");
    this.playback.dispose();
    this.spokenLines.clear();
  }

  // --- Commands ---------------------------------------------------------

  /** Starts a push-to-talk recording. Ignored while the line is down. */
  talk(): void {
    if (!this.state.connected) return;
    void this.pushToTalk.start();
  }

  send(): void {
    this.pushToTalk.stop(true);
  }

  /**
   * Forces a fresh connection and resends every clip still in the outbox.
   * Before `start()` there is no connection to force.
   */
  retry(): void {
    if (!this.link.started) return;
    this.outbox.markAllUnsent();
    this.setStatus("Forcing a fresh connection and retrying...", false);
    this.link.retry();
  }

  toggleHandsFree(): void {
    if (this.state.connected) this.handsFree.toggle();
  }

  selectRoute(route: string): void {
    this.handsFree.stop("route");
    this.setStatus(
      route === "operator"
        ? "Going back to the operator..."
        : "Connecting to " + route + "...",
      false,
    );
    void this.requestLineChange("route", "/connect", {
      project: route,
      generation: this.identity.epoch,
    });
  }

  selectModel(model: string): void {
    this.setStatus("Switching to " + model + "...", false);
    void this.requestLineChange("model", "/model", {
      model,
      generation: this.identity.epoch,
    });
  }

  selectThinking(level: string): void {
    this.setStatus("Setting thinking to " + level + "...", false);
    void this.requestLineChange("thinking", "/thinking", {
      level,
      generation: this.identity.epoch,
    });
  }

  // Goes straight to the backend rather than through the agent on the line,
  // which is the whole point — it has to work when that agent is the problem,
  // including while it is still mid-turn. It carries the epoch this page
  // holds, so it hangs up the leg the caller saw; the service ignores one the
  // call has moved on from, and says so (#263).
  async hangup(): Promise<void> {
    if (this.hangupPending) return;
    this.handsFree.stop("hangup");
    this.hangupPending = true;
    try {
      await this.postJson("/hangup", { generation: this.identity.epoch });
    } catch (err) {
      this.setStatus("Could not hang up: " + errorText(err), true);
    } finally {
      this.hangupPending = false;
    }
  }

  /**
   * Sends a turn the caller typed. Like a clip, it carries the epoch this page
   * holds now, so a transfer that lands before it arrives drops it rather than
   * handing it to the new leg. Returns false, having sent nothing, while the
   * line is down or before the server has announced the epoch; the text is
   * then still the caller's to resend. The server echoes a taken turn as a
   * `transcript` frame with the same id.
   */
  sendText(text: string): boolean {
    const body = text.trim();
    if (!body || !this.link.ready) return false;
    const socket = this.link.socket();
    if (!socket) return false;
    try {
      socket.send(typedTurnMessage({ id: this.newClipId(), epoch: this.identity.epoch, text: body }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends the page's screen-state report. Returns false when there is no open
   * socket to carry it; the backend answers a delivered report with
   * `screen_state_ack`.
   */
  sendScreenState(report: ScreenStateReport): boolean {
    const socket = this.link.socket();
    if (!socket) return false;
    try {
      socket.send(screenStateMessage(report));
      return true;
    } catch {
      return false;
    }
  }

  // --- State ------------------------------------------------------------

  private update(patch: Partial<RuntimeState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof RuntimeState>) {
      if (this.state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.publishState();
  }

  // Several fields usually change together (a reconnect touches status,
  // connection, and hands-free); publish them as one state.
  private publishState(): void {
    if (this.statePublishQueued || !this.link.started) return;
    this.statePublishQueued = true;
    queueMicrotask(() => {
      this.statePublishQueued = false;
      if (!this.link.disposed) this.options.onState({ ...this.state });
    });
  }

  /**
   * Every status says whether it is an error. A status that is not one
   * clears the flag: the page draws the error while the flag stands, and a
   * routine status that kept a flag it did not set was drawn as an error in
   * its place -- the turn after a failure put "Operator is listening..." and
   * then the idle line on screen (#213).
   */
  private setStatus(text: string, error: boolean): void {
    this.update({ status: text, statusError: error });
  }

  private applyLine(): void {
    const availability = pickerAvailability(
      this.line,
      this.lineRequestsPending > 0,
    );
    this.update({
      route: this.line.route,
      routeLabel: this.line.label,
      routes: this.line.routes,
      model: this.line.model,
      models: this.line.models,
      modelTitle: availability.modelTitle,
      thinking: this.line.thinking,
      thinkingLevels: this.line.thinkingLevels,
      onProject: this.line.onProject,
      routeDisabled: availability.routeDisabled,
      modelDisabled: availability.modelDisabled,
      thinkingDisabled: availability.thinkingDisabled,
    });
  }

  private setCallerLevel(level: number): void {
    this.callerVoiceLevel = level;
    if (!this.callerLevelAvailable) {
      this.callerLevelAvailable = true;
      this.update({ voiceLevelAvailable: true });
    }
  }

  private renderHandsFreeState(detail: HandsFreeStateDetail): void {
    const active = detail.state !== "off" && detail.state !== "error";
    const leaseStates =
      detail.state === "lease" || detail.state === "lease_capturing";
    this.update({
      handsFree: active,
      handsFreeStatus: detail.message,
      handsFreeLease: leaseStates
        ? `Follow-up lease: ${Math.ceil(detail.leaseRemainingMs / 1000)} seconds remaining.`
        : "",
      // A hands-free failure goes on screen the way a push-to-talk one does.
      // Nothing on the page draws `handsFreeStatus`, so a detector that
      // failed, or a microphone hands-free could not get, used to turn MODE
      // back to push-to-talk with nothing said at all (#213).
      ...(detail.state === "error"
        ? { status: detail.message, statusError: true }
        : {}),
    });
  }

  // --- Line controls ----------------------------------------------------

  // Requests run one at a time across all three controls, and every picker
  // stays locked until the queue drains. Each carries the epoch the page held
  // when the caller acted, not when it goes out: the service refuses one the
  // call has moved on from, so a request queued behind a slow one cannot act
  // on a leg the caller never chose (#263).
  private async requestLineChange(
    control: LineControl,
    url: string,
    body: Record<string, string | number>,
  ): Promise<void> {
    const request = ++this.lineRequestIds[control];
    this.lineRequestsPending += 1;
    this.applyLine();
    const execute = async () => {
      this.update({ statusError: false });
      try {
        const response = await this.postJson(url, body);
        if (response.error !== null && response.error !== undefined) {
          throw new Error(String(response.error));
        }
      } catch (err) {
        if (this.lineRequestIds[control] === request) {
          this.setStatus("That did not go through: " + errorText(err), true);
        }
      } finally {
        this.lineRequestsPending -= 1;
        this.applyLine();
      }
    };
    const run = this.lineRequestChain
      ? this.lineRequestChain.then(execute, execute)
      : execute();
    this.lineRequestChain = run;
    run.then(
      () => {
        if (this.lineRequestChain === run) this.lineRequestChain = null;
      },
      () => {
        if (this.lineRequestChain === run) this.lineRequestChain = null;
      },
    );
    await run;
  }

  // --- Outbox -----------------------------------------------------------

  private newClipId(): string {
    return globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${++this.clipSequence}`;
  }

  private enqueueOutbox(clip: Clip): boolean {
    if (!this.outbox.add(clip)) {
      this.setStatus(
        "Too many unsent voice clips; reconnect before recording again.",
        true,
      );
      return false;
    }
    return true;
  }

  // Send one unsent clip at a time. Accepted clips stay in the outbox until
  // their transcript arrives, so a backend restart cannot destroy the only
  // copy.
  private flushOutbox(): void {
    if (!this.link.ready || this.outbox.size === 0) return;
    const clip = this.outbox.firstUnsent();
    if (!clip) {
      this.setStatus(`Transcribing ${this.outbox.size} voice clip(s)...`, false);
      return;
    }
    const ws = this.link.socket();
    if (!ws) {
      this.setStatus(`Waiting to send ${this.outbox.size} clip(s)...`, true);
      return;
    }
    try {
      if (clip.streaming && clip.chunks) {
        ws.send(sttStartHeader(clip));
        clip.chunks.forEach((chunk, sequence) => {
          ws.send(sttChunkHeader(clip, sequence));
          ws.send(chunk);
        });
        ws.send(sttEndHeader(clip));
      } else {
        ws.send(clipHeader(clip));
        ws.send(clip.audio);
      }
      clip.sent = true;
      clip.transmitted = true;
      this.setStatus("Waiting for the server to accept your clip...", false);
    } catch {
      // The socket died between frames. The same id and bytes are retried on
      // the next socket; the backend either never saw them or dedupes.
      clip.sent = false;
      this.link.sendFailed(ws);
    }
  }

  /** The id the clip went out under, or null when it was not taken. */
  private submitHandsFreeClip(audio: Blob, mime: string, epoch: number): string | null {
    if (!this.link.ready || epoch !== this.identity.epoch) return null;
    const clip: Clip = {
      id: this.newClipId(),
      audio,
      mime: mime || audio.type || "audio/webm",
      created: Date.now(),
      epoch,
      transferEra: this.identity.candidate ?? undefined,
      sent: false,
      streaming: false,
    };
    if (!this.enqueueOutbox(clip)) return null;
    this.flushOutbox();
    return clip.id;
  }

  // --- Line ------------------------------------------------------------

  /** A socket opened. */
  private lineUp(): void {
    this.setStatus(IDLE_TEXT, false);
    this.update({ connected: true });
    this.outbox.markAllUnsent();
  }

  /**
   * The current socket closed. A keepalive miss or `retry()` replaces the
   * socket without this: the line stays up until the new socket opens or
   * closes.
   */
  private lineDown(): void {
    // Finalise the in-flight recording into the outbox rather than
    // discarding it. Accepted work is already server-owned; unaccepted work
    // remains locally retryable under the same id.
    if (this.pushToTalk.isRecording() || this.pushToTalk.isStarting)
      this.pushToTalk.stop(true);
    this.handsFree.stop("disconnected");
    this.outbox.markAllUnsent();
    this.setStatus("Disconnected. Reconnecting...", true);
    this.update({ connected: false });
  }

  private receive(message: ServerMessage, socket: WebSocket): void {
    this.handleText(message, socket);
    this.options.onServer(message);
    // After `onServer`, so a line is in the transcript before it is heard,
    // even when its audio has already started.
    this.trackSpokenLine(message);
  }

  /**
   * Holds a spoken line until its audio's turn to play comes (#112). Only
   * lines voiced to the caller are captions; a written reply stays in the
   * transcript.
   */
  private trackSpokenLine(message: ServerMessage): void {
    if (message.type === "spoken") {
      if (!message.entry.text) return;
      this.spokenLines.add(
        { text: message.entry.text, route: message.entry.route || undefined },
        message.sequence,
      );
    } else if (message.type === "reply" && message.voiced) {
      this.spokenLines.add(
        { text: message.text, route: message.route || undefined },
        message.sequence,
      );
    }
  }

  /** The one writer of `identity`: the value `message` moves it to. */
  private followIdentity(message: IdentityMessage): IdentityStep {
    const step = follow(this.identity, message);
    this.identity = step.identity;
    return step;
  }

  private handleText(message: ServerMessage, socket: WebSocket): void {
    switch (message.type) {
      case "hello_ack":
        this.link.greeted(socket, message.stt_streaming);
        this.playback.setStreamingEnabled(message.mse_mp3);
        this.flushOutbox();
        break;
      case "epoch":
        // Adopt the server's epoch immediately and retire every queued or
        // currently playing clip from the old leg. Do this before allowing
        // reconnect retry, otherwise a pre-rescue clip can cross the barrier.
        if (typeof message.generation === "number") {
          const epoch = message.generation;
          const { carry, expected } = this.followIdentity(message);
          // A handoff on a live connection lets the goodbye already playing
          // finish: a transfer this tab saw adopted, or a return to the
          // operator (same generation, new route). A hangup, a rescue or a
          // reconnect's first epoch still cuts playback off at once.
          const handoff = this.link.ready && expected;
          const resubmitted = carry ? this.outbox.carry(carry) : 0;
          this.handsFree.epochChanged();
          const neverSent = this.outbox.retireOtherEpochs(epoch);
          this.link.snapshot(socket);
          if (resubmitted > 0) {
            this.setStatus(
              `The line changed while you were talking; ` +
                `sending ${resubmitted} clip(s) along...`,
              false,
            );
          }
          this.flushOutbox();
          if (neverSent > 0) {
            this.setStatus(
              `The line changed before ${neverSent} clip(s) went out. Please repeat that.`,
              true,
            );
          }
          if (handoff) {
            this.playback.handOffToGeneration(epoch);
          } else {
            this.playback.resetForGeneration(epoch);
            this.spokenLines.retire();
          }
        }
        break;
      case "candidate": {
        const { candidate } = this.followIdentity(message).identity;
        if (candidate) this.setStatus(`Connecting to ${candidate}…`, false);
        break;
      }
      case "candidate_cleared": {
        const { unmark } = this.followIdentity(message);
        if (unmark !== null) this.outbox.unmark(unmark);
        if (this.state.status.startsWith("Connecting to ")) {
          this.setStatus(IDLE_TEXT, false);
        }
        break;
      }
      case "audio_start":
        this.playback.receiveAudioStart(message);
        break;
      case "audio_done":
        this.playback.receiveAudioDone(message);
        break;
      case "final_response_audio_closed":
        this.handsFree.replyClosed(message.generation, message.success);
        break;
      case "pong":
        this.link.pong(socket, message.nonce);
        break;
      case "abandoned": {
        this.pushToTalk.abandonStreaming(message.id);
        const clip = this.outbox.find(message.id);
        if (clip) {
          clip.streaming = false;
          clip.sent = false;
          this.setStatus("Streaming unavailable; sending complete clip...", false);
          this.flushOutbox();
        }
        break;
      }
      case "accepted": {
        const clip = this.outbox.find(message.id);
        if (clip) {
          clip.accepted = true;
          this.setStatus("Transcribing...", false);
          this.flushOutbox();
        }
        break;
      }
      case "history": {
        this.spokenLines.clear();
        // A transcript in history is the durable completion acknowledgement.
        // Drop its retained audio even if the live transcript frame was lost.
        const completed = new Set(
          message.entries.map((entry) => entry.id).filter(Boolean),
        );
        this.outbox.retain((clip) => !completed.has(clip.id));
        break;
      }
      case "transcript":
        if (message.text) {
          this.outbox.remove(message.id);
          this.flushOutbox();
        }
        break;
      case "thinking":
        this.setStatus(
          message.route === "operator"
            ? "Operator is listening..."
            : `${this.line.label || "working"} is working...`,
          false,
        );
        break;
      case "queued": {
        const waiting = message.waiting;
        if (message.steered) {
          this.setStatus("Added that to the turn already in progress.", false);
        } else if (waiting > 1) {
          this.setStatus(`Got it — ${waiting} waiting their turn.`, false);
        } else {
          this.setStatus(
            "Got it — you're next, once this turn finishes.",
            false,
          );
        }
        break;
      }
      case "reply":
        this.setStatus(IDLE_TEXT, false);
        this.followIdentity(message);
        break;
      case "status":
        // A settled status means any in-flight transfer is over, one way or
        // the other.
        this.followIdentity(message);
        this.line = lineStateFromStatus(message);
        for (const control of Object.keys(this.lineRequestIds) as LineControl[])
          this.lineRequestIds[control] += 1;
        this.applyLine();
        break;
      case "error":
        if (message.id !== undefined) {
          this.outbox.remove(message.id);
          this.handsFree.clipFailed(message.id);
        }
        this.setStatus("Error: " + message.message, true);
        break;
      case "routing_unavailable":
        // This is deliberately a page error. The backend emits no reply
        // audio when both routing authorities are unavailable.
        this.handsFree.endAwaitedTurn();
        this.setStatus(message.message, true);
        break;
    }
  }
}

/** The two detectors, each from the runtime's option or the local module. */
async function loadDetectors(options: CallRuntimeOptions): Promise<Detectors> {
  const [wake, speech] = await Promise.all([
    (options.loadWakeDetector ?? loadLocalWakeDetector)(),
    (options.loadSpeechEndpointer ?? loadLocalSpeechEndpointer)(),
  ]);
  return { wake, speech };
}

async function loadLocalWakeDetector(): Promise<WakeDetector> {
  const { createWakeWordDetector } = await import("../wake_word");
  return createWakeWordDetector();
}

async function loadLocalSpeechEndpointer(): Promise<SpeechEndpointer> {
  const { createSpeechEndpointer } = await import("../silero_vad");
  return createSpeechEndpointer();
}
