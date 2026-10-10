import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, debugSocketUrl, SocketFeed, type FeedStatus } from '../../src/debug/connection';
import type { DebugFrame } from '../../src/debug/protocol';

class FakeSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  send(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop() {
    this.onclose?.({} as CloseEvent);
  }
}

describe('debug feed connection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('backs off exponentially up to a cap', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
    expect(debugSocketUrl({ protocol: 'http:', host: 'damocles:8766' })).toBe('ws://damocles:8766/ws');
    expect(debugSocketUrl({ protocol: 'https:', host: 'x' })).toBe('wss://x/ws');
  });

  it('batches parsed frames, reports rejects, and reconnects after a drop', () => {
    const sockets: FakeSocket[] = [];
    const batches: DebugFrame[][] = [];
    const rejected: string[] = [];
    const statuses: FeedStatus[] = [];
    const ticks: (() => void)[] = [];
    const feed = new SocketFeed(
      'ws://test/ws',
      { frames: (frames) => batches.push(frames), rejected: (error) => rejected.push(error), status: (status) => statuses.push(status) },
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      (callback) => ticks.push(callback),
    );
    feed.start();
    sockets[0].open();
    sockets[0].send(JSON.stringify({ type: 'log', seq: 1, timestamp_ms: 1, level: 'INFO', target: 't', message: 'a', fields: {} }));
    sockets[0].send(JSON.stringify({ type: 'log', seq: 2, timestamp_ms: 1, level: 'INFO', target: 't', message: 'b', fields: {} }));
    sockets[0].send('{"type":"bogus"}');
    sockets[0].send(JSON.stringify({ type: 'event', seq: 3, timestamp_ms: 1, kind: 'host_link', host: 'h', connected: 'yes' }));
    expect(batches).toHaveLength(0);
    expect(ticks).toHaveLength(1);
    ticks[0]();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((frame) => (frame.type === 'snapshot' ? -1 : frame.seq))).toEqual([1, 2, 3]);
    // The malformed numbered event is passed on as a skip; the reducer counts it.
    expect(batches[0][2]).toEqual({ type: 'skipped', seq: 3, error: 'host_link.connected is not boolean' });
    expect(rejected).toEqual(['unknown frame type "bogus"']);
    sockets[0].drop();
    expect(statuses).toEqual(['connecting', 'live', 'reconnecting']);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    feed.resync();
    expect(sockets[1].closed).toBe(true);
    expect(sockets).toHaveLength(3);
    feed.stop();
    expect(sockets[2].closed).toBe(true);
    sockets[2].drop();
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(3);
  });

  it('keeps backing off while sockets open and close, until one has held its snapshot a while', () => {
    // The listener closes a client that lags or cannot take a frame in time;
    // each of those closes comes after a successful open. Resetting the
    // backoff on open made every such retry wait only the base delay.
    const sockets: FakeSocket[] = [];
    const rejected: string[] = [];
    const feed = new SocketFeed(
      'ws://test/ws',
      { frames: () => {}, rejected: (error) => rejected.push(error), status: () => {} },
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      (callback) => callback(),
    );
    const snapshot = JSON.stringify({
      type: 'snapshot',
      last_seq: 0,
      events: [],
      logs: [],
      agents: [],
      config: { jev_for_current_agent_lower: 0.3, jev_for_current_agent_upper: 0.7, jev_action_threshold: 0.6 },
    });
    /** The time from `sockets[index]` closing to the next socket opening. */
    const retryDelay = (index: number): number => {
      sockets[index].drop();
      let waited = 0;
      while (sockets.length === index + 1) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      return waited;
    };
    feed.start();
    sockets[0].open();
    expect(retryDelay(0)).toBe(500);
    sockets[1].open();
    expect(retryDelay(1)).toBe(1000);
    // A snapshot alone does not reset it: the socket may still be dropped
    // before it can take the next frame.
    sockets[2].open();
    sockets[2].send(snapshot);
    vi.advanceTimersByTime(5_000);
    expect(retryDelay(2)).toBe(2000);
    // A socket that got its snapshot and stayed open resets it.
    sockets[3].open();
    sockets[3].send(snapshot);
    vi.advanceTimersByTime(10_000);
    expect(retryDelay(3)).toBe(500);
    expect(rejected).toEqual([]);
    feed.stop();
  });
});
