// The debug page's live feed: one WebSocket to the debug listener's `/ws`,
// reconnected with capped exponential backoff. Frames are parsed here and
// handed over in batches, at most once per animation frame, so a burst of
// thousands of events costs one render.
import { parseDebugFrame, type DebugFrame } from './protocol';

export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'fixture';

export interface FeedHandlers {
  frames(frames: DebugFrame[]): void;
  rejected(error: string): void;
  status(status: FeedStatus, detail?: string): void;
}

export interface Feed {
  start(): void;
  stop(): void;
  /** Drop the socket and reconnect now, for a fresh snapshot. */
  resync(): void;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;
/**
 * How long a socket has to stay open after its snapshot before the backoff
 * starts again from the base delay. Opening is not enough: the listener
 * closes a client that lags or cannot take a frame in time, after the open,
 * and each reconnect costs it a full snapshot.
 */
export const BACKOFF_RESET_AFTER_MS = 10_000;

/** The wait before reconnect attempt `attempt` (0-based). */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

export function debugSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

type Schedule = (callback: () => void) => void;

const nextFrame: Schedule = (callback) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
  else setTimeout(callback, 16);
};

/** Collect frames and deliver them once per tick. */
export class FrameBatcher {
  private queue: DebugFrame[] = [];
  private scheduled = false;

  constructor(
    private readonly deliver: (frames: DebugFrame[]) => void,
    private readonly schedule: Schedule = nextFrame,
  ) {}

  push(frame: DebugFrame): void {
    this.queue.push(frame);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  flush(): void {
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const frames = this.queue;
    this.queue = [];
    this.deliver(frames);
  }
}

type SocketLike = Pick<WebSocket, 'close'> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
};

type Timer = ReturnType<typeof setTimeout>;

/**
 * Where the feed is. Each phase holds the socket or timer that exists only in
 * it, so a socket and a retry timer are never held at once. `attempt` is the
 * reconnect attempt the next backoff is computed from; `live` has none,
 * because a socket that held its snapshot backs off from the base delay.
 */
type FeedPhase =
  | { kind: 'stopped' }
  /** The socket is made and not open yet. */
  | { kind: 'connecting'; socket: SocketLike; attempt: number }
  /** Open, no snapshot yet. */
  | { kind: 'open'; socket: SocketLike; attempt: number }
  /** The snapshot arrived; `settle` fires once it has been held `BACKOFF_RESET_AFTER_MS`. */
  | { kind: 'settling'; socket: SocketLike; attempt: number; settle: Timer }
  | { kind: 'live'; socket: SocketLike }
  /** No socket; `retry` makes the next one, as attempt `attempt`. */
  | { kind: 'waiting'; attempt: number; retry: Timer };

/**
 * What moves the feed. An event from a socket or a timer names it, so one
 * that outlives the phase holding it is dropped.
 */
type FeedEvent =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'resync' }
  | { kind: 'opened'; socket: SocketLike }
  | { kind: 'snapshot'; socket: SocketLike }
  | { kind: 'closed'; socket: SocketLike }
  | { kind: 'settled'; timer: Timer }
  | { kind: 'retry-due'; timer: Timer };

function socketOf(phase: FeedPhase): SocketLike | null {
  return 'socket' in phase ? phase.socket : null;
}

function timerOf(phase: FeedPhase): Timer | null {
  switch (phase.kind) {
    case 'settling':
      return phase.settle;
    case 'waiting':
      return phase.retry;
    case 'stopped':
    case 'connecting':
    case 'open':
    case 'live':
      return null;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

/** Whether `event` comes from the phase the feed is in, rather than from a socket or timer it has let go of. */
function fromCurrentPhase(phase: FeedPhase, event: FeedEvent): boolean {
  switch (event.kind) {
    case 'start':
    case 'stop':
    case 'resync':
      return true;
    case 'opened':
    case 'snapshot':
    case 'closed':
      return socketOf(phase) === event.socket;
    case 'settled':
    case 'retry-due':
      return timerOf(phase) === event.timer;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * The one teardown: release what `from` holds and `to` does not. Closing a
 * socket that has closed itself does nothing.
 */
function leave(from: FeedPhase, to: FeedPhase): void {
  const timer = timerOf(from);
  if (timer !== null && timer !== timerOf(to)) clearTimeout(timer);
  const socket = socketOf(from);
  if (socket !== null && socket !== socketOf(to)) socket.close();
}

export class SocketFeed implements Feed {
  private phase: FeedPhase = { kind: 'stopped' };
  private readonly batcher: FrameBatcher;

  constructor(
    private readonly url: string,
    private readonly handlers: FeedHandlers,
    private readonly open: (url: string) => SocketLike = (target) => new WebSocket(target),
    schedule?: Schedule,
  ) {
    this.batcher = new FrameBatcher((frames) => handlers.frames(frames), schedule);
  }

  start(): void {
    this.transition({ kind: 'start' });
  }

  stop(): void {
    this.transition({ kind: 'stop' });
  }

  resync(): void {
    this.transition({ kind: 'resync' });
  }

  /** The only writer of `phase`. */
  private transition(event: FeedEvent): void {
    const from = this.phase;
    if (!fromCurrentPhase(from, event)) return;
    const to = this.next(from, event);
    if (to === from) return;
    this.phase = to;
    leave(from, to);
  }

  /**
   * The phase x event table (pinned by `debugFeed.test.ts`): the phase
   * `event` moves the feed to, entered with its socket, timer and status, or
   * `phase` itself when the event changes nothing.
   */
  private next(phase: FeedPhase, event: FeedEvent): FeedPhase {
    switch (event.kind) {
      case 'start':
        return phase.kind === 'stopped' ? this.connect(0) : phase;
      case 'stop':
        return phase.kind === 'stopped' ? phase : { kind: 'stopped' };
      case 'resync':
        return phase.kind === 'stopped' ? phase : this.connect(0);
      case 'opened':
        if (phase.kind !== 'connecting') return phase;
        this.handlers.status('live');
        return { kind: 'open', socket: phase.socket, attempt: phase.attempt };
      case 'snapshot':
        // The hold counts from the first snapshot; a later one changes nothing.
        return phase.kind === 'open' ? this.settle(phase.socket, phase.attempt) : phase;
      case 'settled':
        return phase.kind === 'settling' ? { kind: 'live', socket: phase.socket } : phase;
      case 'closed':
        switch (phase.kind) {
          case 'connecting':
          case 'open':
          case 'settling':
            return this.wait(phase.attempt, 'socket closed');
          case 'live':
            return this.wait(0, 'socket closed');
          case 'stopped':
          case 'waiting':
            return phase;
          default: {
            const exhaustive: never = phase;
            return exhaustive;
          }
        }
      case 'retry-due':
        return phase.kind === 'waiting' ? this.connect(phase.attempt) : phase;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  /** Enter `connecting` with a new socket, or `waiting` if it cannot be made. */
  private connect(attempt: number): FeedPhase {
    this.handlers.status(attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: SocketLike;
    try {
      socket = this.open(this.url);
    } catch (error) {
      return this.wait(attempt, String(error));
    }
    socket.onopen = () => this.transition({ kind: 'opened', socket });
    socket.onmessage = (event) => this.receive(socket, event.data);
    socket.onclose = () => this.transition({ kind: 'closed', socket });
    // No `onerror`: `close` follows an error, and reconnecting there keeps one path.
    return { kind: 'connecting', socket, attempt };
  }

  /** Enter `settling`: the backoff resets once the snapshot has been held a while. */
  private settle(socket: SocketLike, attempt: number): FeedPhase {
    const settle: Timer = setTimeout(() => this.transition({ kind: 'settled', timer: settle }), BACKOFF_RESET_AFTER_MS);
    return { kind: 'settling', socket, attempt, settle };
  }

  /** Enter `waiting`: back off from `attempt`, then connect as attempt `attempt + 1`. */
  private wait(attempt: number, detail: string): FeedPhase {
    const delay = backoffDelay(attempt);
    this.handlers.status('reconnecting', `${detail}; retry in ${Math.round(delay / 100) / 10}s`);
    const retry: Timer = setTimeout(() => this.transition({ kind: 'retry-due', timer: retry }), delay);
    return { kind: 'waiting', attempt: attempt + 1, retry };
  }

  private receive(socket: SocketLike, data: unknown): void {
    // A frame from a socket the feed has let go of is dropped.
    if (socketOf(this.phase) !== socket) return;
    if (typeof data !== 'string') {
      this.handlers.rejected('binary frame');
      return;
    }
    const parsed = parseDebugFrame(data);
    if (!parsed.ok) {
      // A numbered frame keeps its place in the stream as a skip, so it is
      // counted without opening a gap that would force a resync.
      if (parsed.seq !== undefined) this.batcher.push({ type: 'skipped', seq: parsed.seq, error: parsed.error });
      else this.handlers.rejected(parsed.error);
      return;
    }
    for (const skipped of parsed.value.skipped) this.handlers.rejected(`snapshot entry skipped: ${skipped}`);
    if (parsed.value.frame.type === 'snapshot') this.transition({ kind: 'snapshot', socket });
    this.batcher.push(parsed.value.frame);
  }
}
