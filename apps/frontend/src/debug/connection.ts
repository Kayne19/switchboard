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

export class SocketFeed implements Feed {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Resets `attempt` once the socket has held its snapshot a while. */
  private settled: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
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
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.detach()?.close();
  }

  resync(): void {
    if (this.stopped) return;
    this.detach()?.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.connect();
  }

  private detach(): SocketLike | null {
    if (this.settled) clearTimeout(this.settled);
    this.settled = null;
    const socket = this.socket;
    if (socket) socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    this.socket = null;
    return socket;
  }

  private connect(): void {
    this.handlers.status(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: SocketLike;
    try {
      socket = this.open(this.url);
    } catch (error) {
      this.retry(String(error));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.handlers.status('live');
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        this.handlers.rejected('binary frame');
        return;
      }
      const parsed = parseDebugFrame(event.data);
      if (!parsed.ok) {
        // A numbered frame keeps its place in the stream as a skip, so it is
        // counted without opening a gap that would force a resync.
        if (parsed.seq !== undefined) this.batcher.push({ type: 'skipped', seq: parsed.seq, error: parsed.error });
        else this.handlers.rejected(parsed.error);
        return;
      }
      for (const skipped of parsed.value.skipped) this.handlers.rejected(`snapshot entry skipped: ${skipped}`);
      if (parsed.value.frame.type === 'snapshot' && !this.settled) {
        this.settled = setTimeout(() => {
          this.settled = null;
          this.attempt = 0;
        }, BACKOFF_RESET_AFTER_MS);
      }
      this.batcher.push(parsed.value.frame);
    };
    socket.onclose = () => {
      this.detach();
      this.retry('socket closed');
    };
    socket.onerror = () => {
      // `close` follows an error; reconnecting there keeps one path.
    };
  }

  private retry(detail: string): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.handlers.status('reconnecting', `${detail}; retry in ${Math.round(delay / 100) / 10}s`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
