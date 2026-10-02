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
    expect(batches).toHaveLength(0);
    expect(ticks).toHaveLength(1);
    ticks[0]();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((frame) => (frame.type === 'snapshot' ? -1 : frame.seq))).toEqual([1, 2]);
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
});
