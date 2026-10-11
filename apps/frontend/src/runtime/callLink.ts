// The call's WebSocket link: it connects, greets the backend, keeps the
// socket alive, and reconnects 1.5 s after a socket closes.
//
// The link's state is one `Link` value, written only by `transition`. Each
// phase holds what exists only in it (the socket, its keepalive, the
// reconnect timer), and `leave` releases what a phase held when the link
// leaves it. Every socket and timer callback names its socket or timer, so
// one from a socket or timer the link has let go of is dropped. The phase x
// event table is pinned by `tests/unit/callLink.test.ts`, through
// `CallRuntime`.
//
// The link knows nothing of the call. It tells `CallRuntime` when the line
// came up (a socket opened) and went down (the current socket closed), and
// hands it every decoded message and audio frame; `CallRuntime` tells it
// what the backend said about the link: `hello_ack`, the snapshot `epoch`,
// and `pong`.

import { decodeServerMessage, helloMessage, pingMessage, type ServerMessage } from "../protocol";
import { errorText } from "./errors";

const SOCKET_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 20_000;
const PONG_DEADLINE_MS = 8_000;
const RECONNECT_DELAY_MS = 1_500;

type Timer = ReturnType<typeof setTimeout>;

/** An open socket's keepalive: resting until the next ping, or a ping out awaiting its pong. */
type Heartbeat =
  | { kind: "resting"; ping: Timer }
  | { kind: "awaiting"; nonce: string; deadline: Timer };

/**
 * Where the link is. `streaming` is what the last `hello_ack` chose. A new
 * socket's open resets it, and nothing else does, so it outlives the socket
 * that heard it: a take begun while a replacement connects still streams.
 * `snapshot` on `waiting` says the socket the link lost had its snapshot.
 * The page still holds that call: a clip finished meanwhile is said to wait,
 * and the next socket made forgets it.
 */
type Link =
  /** The runtime has not started. */
  | { kind: "idle" }
  /** The socket is made and has not opened, or opened and could not say hello. */
  | { kind: "connecting"; socket: WebSocket; streaming: boolean }
  /** Open, `hello` sent; no snapshot `epoch` yet. */
  | { kind: "open"; socket: WebSocket; heartbeat: Heartbeat; streaming: boolean }
  /** The snapshot `epoch` arrived: clips and typed turns may go. */
  | { kind: "ready"; socket: WebSocket; heartbeat: Heartbeat; streaming: boolean }
  /** No socket; `retry` makes the next one. */
  | { kind: "waiting"; retry: Timer; streaming: boolean; snapshot: boolean }
  | { kind: "disposed" };

/**
 * What moves the link. An event from a socket or a timer names it, so one
 * that outlives the phase holding it is dropped.
 */
type LinkEvent =
  | { kind: "start" }
  | { kind: "retry" }
  | { kind: "dispose" }
  | { kind: "opened"; socket: WebSocket }
  | { kind: "errored"; socket: WebSocket }
  | { kind: "closed"; socket: WebSocket }
  /** A frame could not go: the socket is closed, and its close takes the line down. */
  | { kind: "sendFailed"; socket: WebSocket }
  | { kind: "greeted"; socket: WebSocket; streaming: boolean }
  | { kind: "snapshot"; socket: WebSocket }
  | { kind: "pong"; socket: WebSocket; nonce: string }
  | { kind: "pingDue"; timer: Timer }
  | { kind: "pongMissed"; timer: Timer }
  | { kind: "retryDue"; timer: Timer };

/** What a step tells the call, in order, once the new phase is written. */
type Effect =
  | { kind: "status"; text: string; error: boolean }
  /** A socket opened. */
  | { kind: "lineUp" }
  /** The current socket closed. */
  | { kind: "lineDown" }
  | { kind: "close"; socket: WebSocket };

interface Step {
  to: Link;
  effects: Effect[];
}

export interface CallLinkOptions {
  url: string;
  createSocket: (url: string) => WebSocket;
  /** A socket opened: the line is up. */
  lineUp(): void;
  /**
   * The current socket closed: the line is down. A keepalive miss or
   * `retry()` replaces the socket without it.
   */
  lineDown(): void;
  status(text: string, error: boolean): void;
  /** A decoded backend message, and the socket that carried it. */
  message(message: ServerMessage, socket: WebSocket): void;
  audio(bytes: ArrayBuffer): void;
}

function socketOf(link: Link): WebSocket | null {
  return "socket" in link ? link.socket : null;
}

function timerOf(link: Link): Timer | null {
  switch (link.kind) {
    case "open":
    case "ready":
      return link.heartbeat.kind === "resting"
        ? link.heartbeat.ping
        : link.heartbeat.deadline;
    case "waiting":
      return link.retry;
    case "idle":
    case "connecting":
    case "disposed":
      return null;
    default: {
      const exhaustive: never = link;
      return exhaustive;
    }
  }
}

function streamingOf(link: Link): boolean {
  return "streaming" in link ? link.streaming : false;
}

function snapshotOf(link: Link): boolean {
  return link.kind === "ready" || (link.kind === "waiting" && link.snapshot);
}

/**
 * Whether `event` comes from the phase the link is in, rather than from a
 * socket or timer it has let go of.
 */
function fromCurrentPhase(link: Link, event: LinkEvent): boolean {
  switch (event.kind) {
    case "start":
    case "retry":
    case "dispose":
      return true;
    case "opened":
    case "errored":
    case "closed":
    case "sendFailed":
    case "greeted":
    case "snapshot":
    case "pong":
      return socketOf(link) === event.socket;
    case "pingDue":
    case "pongMissed":
    case "retryDue":
      return timerOf(link) === event.timer;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Closing a socket that is closing or closed does nothing. */
function close(socket: WebSocket): void {
  socket.close();
}

/** The one teardown: release what `from` holds and `to` does not. */
function leave(from: Link, to: Link): void {
  const timer = timerOf(from);
  if (timer !== null && timer !== timerOf(to)) clearTimeout(timer);
  const socket = socketOf(from);
  if (socket !== null && socket !== socketOf(to)) close(socket);
}

const unchanged = (link: Link): Step => ({ to: link, effects: [] });

export class CallLink {
  private phase: Link = { kind: "idle" };
  private pings = 0;

  constructor(private readonly options: CallLinkOptions) {}

  /** Whether `start()` has run; true after `dispose()` too. */
  get started(): boolean {
    return this.phase.kind !== "idle";
  }

  get disposed(): boolean {
    return this.phase.kind === "disposed";
  }

  /** Whether the snapshot `epoch` has arrived, so a clip or a typed turn may go. */
  get ready(): boolean {
    return snapshotOf(this.phase);
  }

  /** Whether the backend chose streaming speech-to-text, as its last `hello_ack` said. */
  get streaming(): boolean {
    return streamingOf(this.phase);
  }

  /** The socket a frame can go on now, or null. */
  socket(): WebSocket | null {
    const socket = socketOf(this.phase);
    return socket && socket.readyState === SOCKET_OPEN ? socket : null;
  }

  start(): void {
    this.transition({ kind: "start" });
  }

  /** Replaces the socket now. The line stays up: the replacement's open or close says what it is. */
  retry(): void {
    this.transition({ kind: "retry" });
  }

  dispose(): void {
    this.transition({ kind: "dispose" });
  }

  /** `hello_ack` arrived on `socket`. */
  greeted(socket: WebSocket, streaming: boolean): void {
    this.transition({ kind: "greeted", socket, streaming });
  }

  /** The snapshot `epoch` arrived on `socket`. */
  snapshot(socket: WebSocket): void {
    this.transition({ kind: "snapshot", socket });
  }

  pong(socket: WebSocket, nonce: string): void {
    this.transition({ kind: "pong", socket, nonce });
  }

  /** A frame could not go on `socket`. */
  sendFailed(socket: WebSocket): void {
    this.transition({ kind: "sendFailed", socket });
  }

  /**
   * The only writer of `phase`. The effects run after it is written and the
   * old phase is left, so a call back into the link sees the new phase.
   */
  private transition(event: LinkEvent): void {
    const from = this.phase;
    if (!fromCurrentPhase(from, event)) return;
    const { to, effects } = this.next(from, event);
    if (to !== from) {
      this.phase = to;
      leave(from, to);
    }
    for (const effect of effects) this.apply(effect);
  }

  /**
   * The phase x event table: the phase `event` moves the link to, entered
   * with its socket and timers, and what to tell the call.
   */
  private next(link: Link, event: LinkEvent): Step {
    switch (event.kind) {
      case "start":
        return link.kind === "idle" ? this.connect(link, []) : unchanged(link);
      case "retry":
        return link.kind === "idle" || link.kind === "disposed"
          ? unchanged(link)
          : this.connect(link, []);
      case "dispose":
        return link.kind === "disposed"
          ? unchanged(link)
          : { to: { kind: "disposed" }, effects: [] };
      case "opened":
        return link.kind === "connecting" ? this.open(link.socket) : unchanged(link);
      case "errored":
        return { to: link, effects: [{ kind: "status", text: "Connection error.", error: true }] };
      case "closed":
        // Any phase holding the socket: `fromCurrentPhase` checked it.
        return {
          to: this.wait(streamingOf(link), snapshotOf(link)),
          effects: [{ kind: "lineDown" }],
        };
      case "sendFailed":
        return { to: link, effects: [{ kind: "close", socket: event.socket }] };
      case "greeted":
        return link.kind === "open" || link.kind === "ready"
          ? { to: { ...link, streaming: event.streaming }, effects: [] }
          : unchanged(link);
      case "snapshot":
        return link.kind === "open"
          ? { to: { ...link, kind: "ready" }, effects: [] }
          : unchanged(link);
      case "pong": {
        if (link.kind !== "open" && link.kind !== "ready") return unchanged(link);
        const { heartbeat } = link;
        return heartbeat.kind === "awaiting" && heartbeat.nonce === event.nonce
          ? { to: { ...link, heartbeat: this.rest() }, effects: [] }
          : unchanged(link);
      }
      case "pingDue":
        return link.kind === "open" || link.kind === "ready" ? this.ping(link) : unchanged(link);
      case "pongMissed":
        if (link.kind !== "open" && link.kind !== "ready") return unchanged(link);
        return this.connect(link, [
          { kind: "status", text: "Keepalive missed. Reconnecting...", error: true },
        ]);
      case "retryDue":
        return link.kind === "waiting" ? this.connect(link, []) : unchanged(link);
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  /**
   * Enter `connecting` with a new socket, or `waiting` if one cannot be
   * made. `from`'s socket, if any, is closed on leaving it.
   */
  private connect(from: Link, effects: Effect[]): Step {
    const streaming = streamingOf(from);
    let socket: WebSocket;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch (error) {
      const text = "Connection error: " + errorText(error);
      effects.push({ kind: "status", text, error: true });
      return { to: this.wait(streaming, snapshotOf(from)), effects };
    }
    socket.binaryType = "arraybuffer";
    socket.onopen = () => this.transition({ kind: "opened", socket });
    socket.onclose = () => this.transition({ kind: "closed", socket });
    socket.onerror = () => this.transition({ kind: "errored", socket });
    socket.onmessage = (event) => this.receive(socket, event.data);
    return { to: { kind: "connecting", socket, streaming }, effects };
  }

  /**
   * Enter `open`: the line is up, and the socket says hello. A socket that
   * cannot say hello stays `connecting` and is closed, and its close takes
   * the line down again.
   */
  private open(socket: WebSocket): Step {
    try {
      socket.send(helloMessage());
    } catch {
      return {
        to: { kind: "connecting", socket, streaming: false },
        effects: [{ kind: "lineUp" }, { kind: "close", socket }],
      };
    }
    return {
      to: { kind: "open", socket, heartbeat: this.rest(), streaming: false },
      effects: [{ kind: "lineUp" }],
    };
  }

  /** Enter `waiting`: the next socket is made `RECONNECT_DELAY_MS` from now. */
  private wait(streaming: boolean, snapshot: boolean): Link {
    const retry: Timer = setTimeout(
      () => this.transition({ kind: "retryDue", timer: retry }),
      RECONNECT_DELAY_MS,
    );
    return { kind: "waiting", retry, streaming, snapshot };
  }

  private rest(): Heartbeat {
    const ping: Timer = setTimeout(
      () => this.transition({ kind: "pingDue", timer: ping }),
      HEARTBEAT_INTERVAL_MS,
    );
    return { kind: "resting", ping };
  }

  /**
   * The ping is due. A socket that is closing sends none and waits for its
   * close; one whose ping cannot go is replaced at once.
   */
  private ping(link: Extract<Link, { kind: "open" | "ready" }>): Step {
    if (link.socket.readyState !== SOCKET_OPEN) return unchanged(link);
    const nonce = `${++this.pings}:${Date.now()}`;
    try {
      link.socket.send(pingMessage(nonce, Date.now()));
    } catch {
      return this.connect(link, []);
    }
    const deadline: Timer = setTimeout(
      () => this.transition({ kind: "pongMissed", timer: deadline }),
      PONG_DEADLINE_MS,
    );
    return { to: { ...link, heartbeat: { kind: "awaiting", nonce, deadline } }, effects: [] };
  }

  private apply(effect: Effect): void {
    switch (effect.kind) {
      case "status":
        return this.options.status(effect.text, effect.error);
      case "lineUp":
        return this.options.lineUp();
      case "lineDown":
        return this.options.lineDown();
      case "close":
        return close(effect.socket);
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
  }

  private receive(socket: WebSocket, data: unknown): void {
    // A frame from a socket the link has let go of is dropped.
    if (socketOf(this.phase) !== socket) return;
    if (typeof data === "string") {
      const message = decodeServerMessage(data);
      if (!message) {
        console.warn(
          "Switchboard: ignored a server message that is not in the protocol:",
          data.slice(0, 200),
        );
        return;
      }
      this.options.message(message, socket);
    } else if (data instanceof ArrayBuffer) {
      this.options.audio(data);
    } else if (data instanceof Blob) {
      void data.arrayBuffer().then((bytes) => {
        if (socketOf(this.phase) === socket) this.options.audio(bytes);
      });
    }
  }
}
