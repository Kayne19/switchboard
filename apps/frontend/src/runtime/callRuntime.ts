// The browser's side of a call: the backend WebSocket, the caller's voice on
// the way in, the agent's voice on the way out, and the line controls.
//
// This is the React app's own transport. It owns no DOM; it reports what it
// is doing through two callbacks -- `onState` for the call's runtime state and
// `onServer` for every decoded backend message -- and the React adapter
// (`integration/runtime.tsx`) turns those into scenes.
//
// Lifecycle: `start()` opens the socket; every socket gets a generation, and a
// callback from a retired generation is a no-op, so reconnects never stack.
// `dispose()` retires the current generation without reconnecting.

import {
  HandsFreeController,
  PLAYBACK_DRAIN_DEBOUNCE_MS,
  type HandsFreeControllerOptions,
  type HandsFreeStateDetail,
  type WakeDetector,
} from "../hands_free";
import {
  clipHeader,
  decodeServerMessage,
  helloMessage,
  postJson,
  sttChunkHeader,
  sttEndHeader,
  sttStartHeader,
  typedTurnMessage,
  type ServerMessage,
} from "../protocol";
import type { ScreenStateReport } from "../controller/types";
import { AudioPlayback } from "./audioPlayback";
import { errorText } from "./errors";
import {
  lineStateFromStatus,
  OPERATOR_LINE,
  pickerAvailability,
  type LineState,
  type SelectOption,
} from "./lineStatus";
import { ClipOutbox, restampStaleClips, type Clip } from "./outbox";
import { PushToTalk, type PushToTalkOptions } from "./pushToTalk";

export const IDLE_TEXT = "Connected. Tap Talk and speak.";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 20_000;
const PONG_DEADLINE_MS = 8_000;
const RECONNECT_DELAY_MS = 1_500;

export interface RuntimeState {
  connected: boolean;
  recording: boolean;
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

interface EventSource {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface CallRuntimeOptions {
  socketUrl: string;
  onState: (state: RuntimeState) => void;
  onServer: (message: ServerMessage) => void;
  createSocket?: (url: string) => WebSocket;
  postJson?: typeof postJson;
  player?: HTMLAudioElement;
  getUserMedia?: PushToTalkOptions["getUserMedia"];
  createRecorder?: PushToTalkOptions["createRecorder"];
  /** Loads the local wake-word detector the first time hands-free starts. */
  loadWakeDetector?: () => Promise<WakeDetector>;
  createHandsFree?: (options: HandsFreeControllerOptions) => HandsFreeController;
  /** Where page-level listeners go: gestures, visibility, and page exit. */
  document?: EventSource & { readonly visibilityState?: DocumentVisibilityState };
  window?: EventSource;
}

type LineControl = "route" | "model" | "thinking";

export class CallRuntime {
  private readonly options: CallRuntimeOptions;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly postJson: typeof postJson;
  private readonly playback: AudioPlayback;
  private readonly pushToTalk: PushToTalk;
  private readonly outbox = new ClipOutbox();
  private state: RuntimeState = { ...INITIAL_RUNTIME_STATE };
  private statePublishQueued = false;
  private line: LineState = OPERATOR_LINE;

  private started = false;
  private disposed = false;
  private ws: WebSocket | null = null;
  private socketGeneration = 0;
  private snapshotReady = false;
  private streamingSelected = false;
  private heartbeatSequence = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPong: string | null = null;
  private clipSequence = 0;

  // The server's turn epoch, as last announced. A clip is stamped with
  // whatever this held when its recording started, so speech begun before a
  // transfer is discarded rather than delivered to the leg that replaced it.
  private turnEpoch = 0;
  // The destination route the browser has been told is connecting, or null.
  // Clips recorded while this is set are addressed to the incoming leg.
  private transferEra: string | null = null;

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

  private handsFree: HandsFreeController | null = null;
  private handsFreeStartup: Promise<void> | null = null;
  private pendingResponseBarrier: {
    responseId: string;
    generation: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  private readonly onDocumentClick = (event: Event) =>
    this.playback.handleGesture(event?.target ?? null);
  private readonly onVisibilityChange = () => {
    if (this.options.document?.visibilityState === "hidden") {
      this.handsFree?.disable("Hands-free stopped while the page is hidden.");
      this.clearResponseBarrier();
    }
  };
  private readonly onPageHide = () => {
    this.handsFree?.disable("Hands-free stopped when the page was left.");
    this.clearResponseBarrier();
  };

  constructor(options: CallRuntimeOptions) {
    this.options = options;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.postJson = options.postJson ?? postJson;
    this.playback = new AudioPlayback({
      player: options.player,
      idleText: IDLE_TEXT,
      onStatus: (text, error) => this.setStatus(text, error),
      onChange: () => this.maybeCompleteResponseBarrier(),
    });
    this.pushToTalk = new PushToTalk({
      idleText: IDLE_TEXT,
      getUserMedia: options.getUserMedia,
      createRecorder: options.createRecorder,
      newClipId: () => this.newClipId(),
      context: () => ({
        epoch: this.turnEpoch,
        transferEra: this.transferEra,
        streamingSelected: this.streamingSelected,
      }),
      openSocket: () => this.openSocket(),
      enqueue: (clip) => this.enqueueOutbox(clip),
      flush: () => this.flushOutbox(),
      onRecordingChange: (recording) => this.update({ recording }),
      onStatus: (text, error) => this.setStatus(text, error),
      pauseHandsFree: () => this.handsFree?.pauseForPtt(),
      resumeHandsFree: () => this.handsFree?.resumeAfterPtt(),
    });
    this.applyLine();
  }

  get currentState(): RuntimeState {
    return { ...this.state };
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.document?.addEventListener("click", this.onDocumentClick);
    this.options.document?.addEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
    this.options.window?.addEventListener("pagehide", this.onPageHide);
    this.publishState();
    this.connect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.document?.removeEventListener("click", this.onDocumentClick);
    this.options.document?.removeEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
    this.options.window?.removeEventListener("pagehide", this.onPageHide);
    // Retire the socket's generation first so its close callback cannot
    // schedule a reconnect.
    this.socketGeneration++;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const socket = this.ws;
    this.ws = null;
    if (
      socket &&
      (socket.readyState === SOCKET_OPEN ||
        socket.readyState === SOCKET_CONNECTING)
    )
      socket.close();
    this.pushToTalk.stop(false);
    this.handsFree?.disable("Hands-free stopped when the page was left.");
    this.clearResponseBarrier();
    this.playback.dispose();
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

  cancel(): void {
    this.pushToTalk.stop(false);
  }

  /** Forces a fresh connection and resends every clip still in the outbox. */
  retry(): void {
    this.outbox.markAllUnsent();
    this.setStatus("Forcing a fresh connection and retrying...", false);
    this.connect();
  }

  toggleHandsFree(): void {
    if (!this.state.connected || this.handsFreeStartup) return;
    if (this.handsFree?.isEnabled) {
      this.handsFree.disable();
    } else {
      void this.enableHandsFree();
    }
  }

  selectRoute(route: string): void {
    this.handsFree?.disable("Hands-free stopped while changing the line.");
    this.clearResponseBarrier();
    this.setStatus(
      route === "operator"
        ? "Going back to the operator..."
        : "Connecting to " + route + "...",
    );
    void this.requestLineChange("route", "/connect", { project: route });
  }

  selectModel(model: string): void {
    this.setStatus("Switching to " + model + "...");
    void this.requestLineChange("model", "/model", { model });
  }

  selectThinking(level: string): void {
    this.setStatus("Setting thinking to " + level + "...");
    void this.requestLineChange("thinking", "/thinking", { level });
  }

  // Goes straight to the backend rather than through the agent on the line,
  // which is the whole point — it has to work when that agent is the problem,
  // including while it is still mid-turn.
  async hangup(): Promise<void> {
    if (this.hangupPending) return;
    this.handsFree?.disable("Hands-free stopped for hangup.");
    this.clearResponseBarrier();
    this.hangupPending = true;
    try {
      await this.postJson("/hangup", {});
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
    if (!body || !this.snapshotReady) return false;
    const socket = this.openSocket();
    if (!socket) return false;
    try {
      socket.send(typedTurnMessage({ id: this.newClipId(), epoch: this.turnEpoch, text: body }));
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
    const socket = this.openSocket();
    if (!socket) return false;
    try {
      socket.send(JSON.stringify({ type: "screen_state", ...report }));
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
    if (this.statePublishQueued || !this.started) return;
    this.statePublishQueued = true;
    queueMicrotask(() => {
      this.statePublishQueued = false;
      if (!this.disposed) this.options.onState({ ...this.state });
    });
  }

  /** `error` undefined leaves the current error flag as it is. */
  private setStatus(text: string, error?: boolean): void {
    this.update(
      error === undefined
        ? { status: text }
        : { status: text, statusError: error },
    );
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
    });
  }

  // --- Line controls ----------------------------------------------------

  // Requests run one at a time across all three controls, and every picker
  // stays locked until the queue drains.
  private async requestLineChange(
    control: LineControl,
    url: string,
    body: Record<string, string>,
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
    if (!this.snapshotReady || this.outbox.size === 0) return;
    const clip = this.outbox.firstUnsent();
    if (!clip) {
      this.setStatus(`Transcribing ${this.outbox.size} voice clip(s)...`, false);
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== SOCKET_OPEN) {
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
      this.setStatus("Waiting for the server to accept your clip...", false);
    } catch {
      // The socket died between frames. The same id and bytes are retried on
      // the next generation; the backend either never saw them or dedupes.
      clip.sent = false;
      ws.close();
    }
  }

  private submitHandsFreeClip(audio: Blob, mime: string, epoch: number): void {
    if (!this.snapshotReady || epoch !== this.turnEpoch) return;
    const clip: Clip = {
      id: this.newClipId(),
      audio,
      mime: mime || audio.type || "audio/webm",
      created: Date.now(),
      epoch,
      transferEra: this.transferEra ?? undefined,
      sent: false,
      streaming: false,
    };
    if (!this.enqueueOutbox(clip)) return;
    this.flushOutbox();
  }

  // --- Hands-free -------------------------------------------------------

  private async enableHandsFree(): Promise<void> {
    if (this.handsFree) {
      await this.handsFree.enable();
      return;
    }
    if (this.handsFreeStartup) return this.handsFreeStartup;
    this.handsFreeStartup = (async () => {
      this.renderHandsFreeState({
        state: "starting",
        message: "Loading the local wake-word detector...",
        leaseRemainingMs: 0,
      });
      try {
        const loadWakeDetector =
          this.options.loadWakeDetector ?? loadLocalWakeDetector;
        const wakeDetector = await loadWakeDetector();
        if (this.disposed) return;
        const handsFreeOptions: HandsFreeControllerOptions = {
          wakeDetector,
          isSnapshotReady: () => this.snapshotReady,
          currentEpoch: () => this.turnEpoch,
          isPttActive: () => this.pushToTalk.isActive,
          onClip: (audio, mime, epoch) =>
            this.submitHandsFreeClip(audio, mime, epoch),
          onState: (detail) => this.renderHandsFreeState(detail),
        };
        this.handsFree = this.options.createHandsFree
          ? this.options.createHandsFree(handsFreeOptions)
          : new HandsFreeController(handsFreeOptions);
        await this.handsFree.enable();
      } catch (error) {
        this.handsFree = null;
        this.renderHandsFreeState({
          state: "error",
          message: `Hands-free detector could not load (${errorText(error)}).`,
          leaseRemainingMs: 0,
        });
      } finally {
        this.handsFreeStartup = null;
      }
    })();
    return this.handsFreeStartup;
  }

  private clearResponseBarrier(): void {
    const barrier = this.pendingResponseBarrier;
    if (barrier?.timer !== null && barrier?.timer !== undefined) {
      this.clearTimer(barrier.timer);
    }
    this.pendingResponseBarrier = null;
  }

  // A settled response opens one follow-up lease, but only once the server
  // has closed the response's audio and everything queued here has played.
  private maybeCompleteResponseBarrier(): void {
    const barrier = this.pendingResponseBarrier;
    if (!barrier || !this.snapshotReady || barrier.generation !== this.turnEpoch)
      return;
    if (!this.playback.isDrained()) {
      if (barrier.timer !== null) this.clearTimer(barrier.timer);
      barrier.timer = null;
      return;
    }
    if (barrier.timer !== null) return;
    barrier.timer = setTimeout(() => {
      if (
        this.pendingResponseBarrier !== barrier ||
        !this.playback.isDrained() ||
        !this.snapshotReady ||
        barrier.generation !== this.turnEpoch
      )
        return;
      this.pendingResponseBarrier = null;
      this.handsFree?.openFollowUpLease(barrier.generation);
    }, PLAYBACK_DRAIN_DEBOUNCE_MS);
  }

  // --- Socket -----------------------------------------------------------

  private openSocket(): WebSocket | null {
    const ws = this.ws;
    return ws && ws.readyState === SOCKET_OPEN ? ws : null;
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) clearTimeout(timer);
  }

  private stopHeartbeat(): void {
    this.clearTimer(this.heartbeatTimer);
    this.clearTimer(this.pongDeadlineTimer);
    this.heartbeatTimer = null;
    this.pongDeadlineTimer = null;
    this.pendingPong = null;
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    const ping = () => {
      if (
        generation !== this.socketGeneration ||
        socket !== this.ws ||
        socket.readyState !== SOCKET_OPEN
      )
        return;
      const nonce = `${generation}:${Date.now()}:${++this.heartbeatSequence}`;
      this.pendingPong = nonce;
      try {
        socket.send(JSON.stringify({ type: "ping", nonce, time: Date.now() }));
      } catch {
        socket.close();
        this.connect();
        return;
      }
      this.clearTimer(this.pongDeadlineTimer);
      this.pongDeadlineTimer = setTimeout(() => {
        if (
          generation === this.socketGeneration &&
          socket === this.ws &&
          this.pendingPong === nonce
        ) {
          this.setStatus("Keepalive missed. Reconnecting...", true);
          socket.close();
          this.connect();
        }
      }, PONG_DEADLINE_MS);
    };
    this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(ping, HEARTBEAT_INTERVAL_MS);
  }

  private connect(): void {
    if (this.disposed) return;
    const generation = ++this.socketGeneration;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();

    // Incrementing the generation first makes every callback from the old
    // socket a no-op, including its close callback. This is what prevents a
    // manual retry from stacking another reconnect timer behind itself.
    const previous = this.ws;
    this.ws = null;
    if (
      previous &&
      (previous.readyState === SOCKET_OPEN ||
        previous.readyState === SOCKET_CONNECTING)
    )
      previous.close();

    let socket: WebSocket;
    try {
      socket = this.createSocket(this.options.socketUrl);
    } catch (error) {
      this.setStatus("Connection error: " + errorText(error), true);
      this.scheduleReconnect(generation);
      return;
    }
    this.snapshotReady = false;
    this.ws = socket;
    socket.binaryType = "arraybuffer";
    const current = () => generation === this.socketGeneration && socket === this.ws;

    socket.onopen = () => {
      if (!current()) return;
      this.setStatus(IDLE_TEXT, false);
      this.update({ connected: true });
      this.outbox.markAllUnsent();
      this.snapshotReady = false;
      this.streamingSelected = false;
      try {
        socket.send(helloMessage());
      } catch {
        socket.close();
        return;
      }
      this.startHeartbeat(socket, generation);
    };

    socket.onclose = () => {
      if (!current()) return;
      // Finalise the in-flight recording into the outbox rather than
      // discarding it. Accepted work is already server-owned; unaccepted work
      // remains locally retryable under the same id.
      if (this.pushToTalk.isRecording() || this.pushToTalk.isStarting)
        this.pushToTalk.stop(true);
      this.handsFree?.disable("Hands-free stopped while disconnected.");
      this.clearResponseBarrier();
      this.stopHeartbeat();
      this.outbox.markAllUnsent();
      this.setStatus("Disconnected. Reconnecting...", true);
      this.update({ connected: false });
      this.scheduleReconnect(generation);
    };

    socket.onerror = () => {
      if (!current()) return;
      this.setStatus("Connection error.", true);
    };

    socket.onmessage = (event) => {
      if (!current()) return;
      if (typeof event.data === "string") {
        const message = decodeServerMessage(event.data);
        if (!message) {
          console.warn(
            "Switchboard: ignored a server message that is not in the protocol:",
            event.data.slice(0, 200),
          );
          return;
        }
        this.handleText(message, socket, generation);
        this.options.onServer(message);
      } else if (event.data instanceof ArrayBuffer) {
        this.playback.receiveAudioChunk(event.data);
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((bytes) => {
          if (current()) this.playback.receiveAudioChunk(bytes);
        });
      }
    };
  }

  private scheduleReconnect(generation: number): void {
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (generation === this.socketGeneration) this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private handleText(
    message: ServerMessage,
    socket: WebSocket,
    generation: number,
  ): void {
    switch (message.type) {
      case "hello_ack":
        this.streamingSelected = message.stt_streaming;
        this.playback.setStreamingEnabled(message.mse_mp3);
        this.flushOutbox();
        break;
      case "epoch":
        // Adopt the server's epoch immediately and retire every queued or
        // currently playing clip from the old leg. Do this before allowing
        // reconnect retry, otherwise a pre-rescue clip can cross the barrier.
        if (typeof message.generation === "number") {
          const epoch = message.generation;
          const resubmitted = restampStaleClips(this.outbox.all, epoch);
          this.handsFree?.epochChanged();
          this.clearResponseBarrier();
          this.outbox.retain((clip) => clip.epoch === epoch);
          this.turnEpoch = epoch;
          this.snapshotReady = true;
          if (this.transferEra) {
            this.transferEra = null;
            if (resubmitted > 0) {
              this.setStatus(
                `The line changed while you were talking; ` +
                  `sending ${resubmitted} clip(s) along...`,
                false,
              );
            }
          }
          this.flushOutbox();
          this.playback.resetForGeneration(epoch);
        }
        break;
      case "candidate":
        // A new leg is being started. Speech recorded from here until the
        // epoch moves is addressed to that leg, not to the one on screen.
        this.transferEra =
          message.route && message.route !== "operator" ? message.route : null;
        if (this.transferEra) {
          this.setStatus(`Connecting to ${this.transferEra}…`, false);
        }
        break;
      case "candidate_cleared":
        // The transfer was rolled back or interrupted. The epoch did not
        // move, so queued clips keep their stamp and stay on this leg.
        this.transferEra = null;
        if (this.state.status.startsWith("Connecting to ")) {
          this.setStatus(IDLE_TEXT, false);
        }
        break;
      case "audio_start":
        this.playback.receiveAudioStart(message);
        break;
      case "audio_done":
        this.playback.receiveAudioDone(message);
        break;
      case "final_response_audio_closed":
        if (message.generation === this.turnEpoch) {
          this.clearResponseBarrier();
          if (!message.success) {
            this.update({
              handsFreeStatus:
                "Hands-free follow-up is waiting for a successful response.",
            });
          } else {
            this.pendingResponseBarrier = {
              responseId: message.response_id,
              generation: message.generation,
              timer: null,
            };
            this.maybeCompleteResponseBarrier();
          }
        }
        break;
      case "pong":
        if (message.nonce === this.pendingPong) {
          this.pendingPong = null;
          this.clearTimer(this.pongDeadlineTimer);
          this.pongDeadlineTimer = null;
          this.startHeartbeat(socket, generation);
        }
        break;
      case "abandoned": {
        this.pushToTalk.abandonStreaming(message.id);
        const clip = this.outbox.find(message.id);
        if (clip) {
          clip.streaming = false;
          clip.sent = false;
          this.setStatus("Streaming unavailable; sending complete clip...");
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
        this.setStatus(IDLE_TEXT);
        this.transferEra = null;
        break;
      case "status":
        // A settled status means any in-flight transfer is over, one way or
        // the other.
        this.transferEra = null;
        this.line = lineStateFromStatus(message);
        for (const control of Object.keys(this.lineRequestIds) as LineControl[])
          this.lineRequestIds[control] += 1;
        this.applyLine();
        break;
      case "error":
        if (message.id !== undefined) this.outbox.remove(message.id);
        this.setStatus("Error: " + message.message, true);
        break;
    }
  }
}

async function loadLocalWakeDetector(): Promise<WakeDetector> {
  const { createWakeWordDetector } = await import("../wake_word");
  return createWakeWordDetector();
}
