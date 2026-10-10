import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_RESET_AFTER_MS, backoffDelay, debugSocketUrl, SocketFeed, type FeedStatus } from '../../src/debug/connection';
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

/**
 * The feed's lifecycle, phase by event. Each row puts a fresh feed in a
 * phase, applies one event, and checks what the event did (statuses, the
 * phase's socket closed, sockets opened) and which phase it left the feed in.
 * A phase is not visible from outside, so `expectPhase` recognises it by
 * behaviour: when the next socket opens, and how long the next retry waits.
 * `attempt` is the reconnect attempt the phase holds; rows start at 2 so a
 * reset to 0 shows.
 */
describe('debug feed lifecycle: phase x event', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Phase = 'stopped' | 'connecting' | 'open' | 'settling' | 'live' | 'waiting';
  type Event = 'start' | 'stop' | 'resync' | 'opened' | 'snapshot' | 'frame' | 'closed' | 'held' | 'retry-due';
  /** Where a row leaves the feed. `settlesIn`/`retryIn`: ms left on that phase's timer. */
  type Then =
    | { phase: 'stopped' }
    | { phase: 'connecting' | 'open'; attempt: number }
    | { phase: 'settling'; attempt: number; settlesIn: number }
    | { phase: 'live' }
    | { phase: 'waiting'; attempt: number; retryIn: number };
  interface Row {
    from: Phase;
    event: Event;
    statuses: string[];
    /** Whether the phase's socket is closed by the feed; omitted where the socket closed itself. */
    closes?: boolean;
    opens: number;
    then: Then;
  }

  const SETTLING_HELD_MS = 5_000;
  const snapshot = JSON.stringify({
    type: 'snapshot',
    last_seq: 0,
    events: [],
    logs: [],
    agents: [],
    config: { jev_for_current_agent_lower: 0.3, jev_for_current_agent_upper: 0.7, jev_action_threshold: 0.6 },
  });
  const logFrame = JSON.stringify({ type: 'log', seq: 1, timestamp_ms: 1, level: 'INFO', target: 't', message: 'a', fields: {} });

  function harness() {
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const frames: DebugFrame[] = [];
    const feed = new SocketFeed(
      'ws://test/ws',
      {
        frames: (batch) => frames.push(...batch),
        rejected: (error) => statuses.push(`rejected: ${error}`),
        status: (status, detail) => statuses.push(detail ? `${status}: ${detail}` : status),
      },
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      (callback) => callback(),
    );
    return { feed, sockets, statuses, frames, latest: () => sockets[sockets.length - 1] };
  }
  type Harness = ReturnType<typeof harness>;

  /** A feed in `phase`, holding attempt 2 where the phase has one. */
  function reach(phase: Phase): Harness {
    const h = harness();
    if (phase === 'stopped') return h;
    h.feed.start();
    h.latest().drop();
    vi.advanceTimersByTime(backoffDelay(0));
    h.latest().drop();
    vi.advanceTimersByTime(backoffDelay(1));
    // connecting, attempt 2
    if (phase === 'waiting') h.latest().drop();
    if (phase === 'open' || phase === 'settling' || phase === 'live') h.latest().open();
    if (phase === 'settling' || phase === 'live') h.latest().send(snapshot);
    if (phase === 'settling') vi.advanceTimersByTime(SETTLING_HELD_MS);
    if (phase === 'live') vi.advanceTimersByTime(BACKOFF_RESET_AFTER_MS);
    h.statuses.length = 0;
    return h;
  }

  function apply(h: Harness, event: Event): void {
    switch (event) {
      case 'start':
        return h.feed.start();
      case 'stop':
        return h.feed.stop();
      case 'resync':
        return h.feed.resync();
      case 'opened':
        return h.latest().open();
      case 'snapshot':
        return h.latest().send(snapshot);
      case 'frame':
        return h.latest().send(logFrame);
      case 'closed':
        return h.latest().drop();
      case 'held':
        return void vi.advanceTimersByTime(BACKOFF_RESET_AFTER_MS - SETTLING_HELD_MS);
      case 'retry-due':
        return void vi.advanceTimersByTime(backoffDelay(2));
    }
  }

  /** How long after the current socket drops the next one opens. */
  function retryDelay(h: Harness): number {
    const count = h.sockets.length;
    h.latest().drop();
    let waited = 0;
    while (h.sockets.length === count && waited < 60_000) {
      vi.advanceTimersByTime(100);
      waited += 100;
    }
    return waited;
  }

  function expectPhase(h: Harness, then: Then): void {
    const count = h.sockets.length;
    // Only settling (the hold) and waiting (the retry) hold a timer. `live`
    // is not counted: there a later snapshot may arm a hold that resets an
    // attempt already at 0.
    if (then.phase !== 'live') expect(vi.getTimerCount()).toBe(then.phase === 'settling' || then.phase === 'waiting' ? 1 : 0);
    switch (then.phase) {
      case 'stopped':
        h.statuses.length = 0;
        h.latest()?.drop();
        vi.advanceTimersByTime(60_000);
        h.feed.resync();
        expect(h.sockets).toHaveLength(count);
        expect(h.statuses).toEqual([]);
        return;
      case 'connecting':
      case 'open':
        expect(h.latest().closed).toBe(false);
        expect(retryDelay(h)).toBe(backoffDelay(then.attempt));
        return;
      case 'settling':
        // Not reset before the snapshot has been held long enough ...
        vi.advanceTimersByTime(then.settlesIn - 1);
        expect(h.sockets).toHaveLength(count);
        // ... and reset once it has.
        vi.advanceTimersByTime(1);
        expect(retryDelay(h)).toBe(backoffDelay(0));
        return;
      case 'live':
        expect(retryDelay(h)).toBe(backoffDelay(0));
        return;
      case 'waiting':
        h.statuses.length = 0;
        vi.advanceTimersByTime(then.retryIn - 1);
        expect(h.sockets).toHaveLength(count);
        vi.advanceTimersByTime(1);
        expect(h.sockets).toHaveLength(count + 1);
        expect(h.statuses).toEqual(['reconnecting']);
        expect(retryDelay(h)).toBe(backoffDelay(then.attempt));
        return;
    }
  }

  const leaves = (from: Phase): Row[] => {
    const hasSocket = from !== 'stopped' && from !== 'waiting';
    return [
      { from, event: 'stop', statuses: [], ...(hasSocket ? { closes: true } : {}), opens: 0, then: { phase: 'stopped' } },
      from === 'stopped'
        ? { from, event: 'resync', statuses: [], opens: 0, then: { phase: 'stopped' } }
        : { from, event: 'resync', statuses: ['connecting'], ...(hasSocket ? { closes: true } : {}), opens: 1, then: { phase: 'connecting', attempt: 0 } },
    ];
  };
  const closedRetry = (attempt: number): Row['then'] => ({ phase: 'waiting', attempt: attempt + 1, retryIn: backoffDelay(attempt) });
  const retryStatus = (attempt: number) => `reconnecting: socket closed; retry in ${backoffDelay(attempt) / 1000}s`;

  const rows: Row[] = [
    { from: 'stopped', event: 'start', statuses: ['connecting'], opens: 1, then: { phase: 'connecting', attempt: 0 } },
    ...leaves('stopped'),

    ...leaves('connecting'),
    { from: 'connecting', event: 'opened', statuses: ['live'], closes: false, opens: 0, then: { phase: 'open', attempt: 2 } },
    { from: 'connecting', event: 'closed', statuses: [retryStatus(2)], opens: 0, then: closedRetry(2) },

    ...leaves('open'),
    { from: 'open', event: 'frame', statuses: [], closes: false, opens: 0, then: { phase: 'open', attempt: 2 } },
    {
      from: 'open',
      event: 'snapshot',
      statuses: [],
      closes: false,
      opens: 0,
      then: { phase: 'settling', attempt: 2, settlesIn: BACKOFF_RESET_AFTER_MS },
    },
    { from: 'open', event: 'closed', statuses: [retryStatus(2)], opens: 0, then: closedRetry(2) },

    ...leaves('settling'),
    {
      from: 'settling',
      event: 'frame',
      statuses: [],
      closes: false,
      opens: 0,
      then: { phase: 'settling', attempt: 2, settlesIn: BACKOFF_RESET_AFTER_MS - SETTLING_HELD_MS },
    },
    // A second snapshot does not restart the hold: it counts from the first.
    {
      from: 'settling',
      event: 'snapshot',
      statuses: [],
      closes: false,
      opens: 0,
      then: { phase: 'settling', attempt: 2, settlesIn: BACKOFF_RESET_AFTER_MS - SETTLING_HELD_MS },
    },
    { from: 'settling', event: 'held', statuses: [], closes: false, opens: 0, then: { phase: 'live' } },
    { from: 'settling', event: 'closed', statuses: [retryStatus(2)], opens: 0, then: closedRetry(2) },

    ...leaves('live'),
    { from: 'live', event: 'frame', statuses: [], closes: false, opens: 0, then: { phase: 'live' } },
    { from: 'live', event: 'snapshot', statuses: [], closes: false, opens: 0, then: { phase: 'live' } },
    { from: 'live', event: 'closed', statuses: [retryStatus(0)], opens: 0, then: closedRetry(0) },

    ...leaves('waiting'),
    { from: 'waiting', event: 'retry-due', statuses: ['reconnecting'], opens: 1, then: { phase: 'connecting', attempt: 3 } },

    // A feed starts once: `start` on a running feed changes nothing.
    { from: 'connecting', event: 'start', statuses: [], closes: false, opens: 0, then: { phase: 'connecting', attempt: 2 } },
    { from: 'open', event: 'start', statuses: [], closes: false, opens: 0, then: { phase: 'open', attempt: 2 } },
    {
      from: 'settling',
      event: 'start',
      statuses: [],
      closes: false,
      opens: 0,
      then: { phase: 'settling', attempt: 2, settlesIn: BACKOFF_RESET_AFTER_MS - SETTLING_HELD_MS },
    },
    { from: 'live', event: 'start', statuses: [], closes: false, opens: 0, then: { phase: 'live' } },
    { from: 'waiting', event: 'start', statuses: [], opens: 0, then: { phase: 'waiting', attempt: 3, retryIn: backoffDelay(2) } },
  ];

  it.each(rows.map((row) => [`${row.from} + ${row.event} -> ${row.then.phase}`, row] as const))('%s', (_name, row) => {
    const h = reach(row.from);
    const socket = row.from === 'stopped' || row.from === 'waiting' ? undefined : h.latest();
    const count = h.sockets.length;
    apply(h, row.event);
    expect(h.statuses).toEqual(row.statuses);
    if (row.closes !== undefined) expect(socket?.closed).toBe(row.closes);
    expect(h.sockets).toHaveLength(count + row.opens);
    expectPhase(h, row.then);
  });

  it('ignores every event from a socket it has let go of', () => {
    for (const leave of ['resync', 'stop'] as const) {
      const h = reach('open');
      const old = h.latest();
      h.feed[leave]();
      const count = h.sockets.length;
      h.statuses.length = 0;
      h.frames.length = 0;
      old.open();
      old.send(snapshot);
      old.send(logFrame);
      old.send('{"type":"bogus"}');
      old.drop();
      vi.advanceTimersByTime(60_000);
      expect(h.statuses).toEqual([]);
      expect(h.frames).toEqual([]);
      expect(h.sockets).toHaveLength(count);
    }
  });

  it('starts a stopped feed again from the base delay', () => {
    const h = reach('waiting');
    h.feed.stop();
    h.feed.start();
    expect(h.statuses).toEqual(['connecting']);
    expect(retryDelay(h)).toBe(backoffDelay(0));
  });

  it('waits and retries when the socket cannot be made', () => {
    const statuses: string[] = [];
    let calls = 0;
    const feed = new SocketFeed(
      'ws://test/ws',
      { frames: () => {}, rejected: () => {}, status: (status, detail) => statuses.push(detail ? `${status}: ${detail}` : status) },
      () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return new FakeSocket();
      },
      (callback) => callback(),
    );
    feed.start();
    expect(statuses).toEqual(['connecting', 'reconnecting: Error: boom; retry in 0.5s']);
    vi.advanceTimersByTime(backoffDelay(0) - 1);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(2);
    expect(statuses.at(-1)).toBe('reconnecting');
    feed.stop();
  });
});
