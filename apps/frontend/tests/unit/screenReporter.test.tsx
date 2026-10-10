// @vitest-environment jsdom
// The page's screen-state reports, as one phase x event table (issue #378,
// lifecycle map machine `screen-reports`). The page reports what it shows
// with stop-and-wait: one report waits for its `screen_state_ack`, and the
// newest scene waits behind it. Each row drives the real runtime adapter with
// the frames the backend sends and checks what goes out on the wire.
//
// Phases: `unready` (no `epoch` on this connection yet, or the line went
// down), `idle` (ready, nothing waits for an ack), `awaiting` (one report is
// on the wire; the newest scene may be queued behind it).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControllerProvider } from '../../src/controller/context';
import { RuntimeIntegration } from '../../src/integration/runtime';
import { helloAck, statusMessage } from '../fixtures/serverMessages';

type Report = Record<string, unknown> & { object_ids?: string[] };

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  reports(): Report[] {
    return this.sent
      .filter((frame): frame is string => typeof frame === 'string')
      .map((frame) => JSON.parse(frame) as Report)
      .filter((frame) => frame.type === 'screen_state');
  }
}

let host: HTMLDivElement;
let root: Root;

function socket(): FakeSocket {
  return FakeSocket.all.at(-1)!;
}

function frame(message: object): MessageEvent {
  return { data: JSON.stringify(message) } as MessageEvent;
}

async function receive(...messages: object[]) {
  await act(async () => {
    for (const message of messages) socket().onmessage?.(frame(message));
  });
}

const status = statusMessage({ route: 'operator', label: 'Operator' });
const ack = { type: 'screen_state_ack' };

function show(id: string, seq?: number) {
  return {
    type: 'display',
    ...(seq === undefined ? {} : { seq }),
    action: { op: 'show', id, type: 'metric', role: 'primary', data: { label: id.toUpperCase(), value: '1' } },
  };
}

// An action no page version knows: the page declines it.
function unknown(seq?: number) {
  return { type: 'display', ...(seq === undefined ? {} : { seq }), action: { op: 'explode', id: 'x' } };
}

async function open() {
  await act(async () => {
    socket().readyState = 1;
    socket().onopen?.({} as Event);
  });
  await receive(helloAck());
}

// Every report on every socket this page opened, oldest first.
function sent(): Report[] {
  return FakeSocket.all.flatMap((each) => each.reports());
}

// What the reports sent since `mark` show, as object ids.
function shownSince(mark: number): string[][] {
  return sent()
    .slice(mark)
    .map((report) => report.object_ids ?? []);
}

/** Connected, the epoch announced, and every report acknowledged. */
async function idle(generation = 1) {
  await open();
  await receive({ type: 'epoch', generation }, status);
  await settle();
}

/** Acknowledges until the page has nothing newer to send. */
async function settle() {
  for (let count = -1; count !== sent().length; ) {
    count = sent().length;
    await receive(ack);
  }
}

/** One report, showing `a`, waits for its ack. */
async function awaiting() {
  await idle();
  await receive(show('a', 1));
  expect(sent().at(-1)?.object_ids).toEqual(['a']);
}

async function lineDown() {
  await act(async () => {
    socket().readyState = 3;
    socket().onclose?.({} as CloseEvent);
  });
}

// The runtime reconnects after its delay on a new socket.
async function reconnect() {
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await open();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?ws=ws://switchboard.test/ws');
  host = document.createElement('div');
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ControllerProvider>
        <RuntimeIntegration />
      </ControllerProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('screen reports: phase x event', () => {
  describe('unready', () => {
    it('unready | scene: nothing is sent before the epoch', async () => {
      await open();
      await receive(status, show('a', 1));
      expect(sent()).toEqual([]);
    });

    it('unready | epoch: the page reports at the new generation, and the scene queued before it is not sent', async () => {
      await open();
      await receive(show('a', 1));
      await receive({ type: 'epoch', generation: 3 }, status);
      await settle();
      expect(sent().length).toBeGreaterThan(0);
      expect(sent().every((report) => report.generation === 3)).toBe(true);
      // The epoch reset the stage, so nothing reports `a`.
      expect(sent().some((report) => report.object_ids?.includes('a'))).toBe(false);
    });

    it('unready | ack: a stray ack before the epoch sends nothing', async () => {
      await open();
      await receive(show('a', 1), ack);
      expect(sent()).toEqual([]);
    });

    it('unready (line down) | scene: nothing is sent while the line is down', async () => {
      await idle();
      const mark = sent().length;
      await lineDown();
      await receive(show('a', 1));
      expect(sent().length).toBe(mark);
    });
  });

  describe('idle', () => {
    it('idle | scene: the report goes at once', async () => {
      await idle();
      const mark = sent().length;
      await receive(show('a', 1));
      expect(shownSince(mark)).toEqual([['a']]);
      expect(sent().at(-1)).toMatchObject({ generation: 1, applied_seq: 1, has_visual: true });
    });

    it('idle | display rejected: a report carrying the rejection goes at once', async () => {
      await idle();
      const mark = sent().length;
      await receive(unknown(5));
      expect(sent().slice(mark)).toHaveLength(1);
      expect(sent().at(-1)?.rejected).toMatchObject({ seq: 5 });
    });

    it('idle | display rejected without a seq: the same report goes again', async () => {
      await idle();
      const before = sent().at(-1);
      const mark = sent().length;
      await receive(unknown());
      expect(sent().slice(mark)).toEqual([before]);
    });

    it('idle | ack: a stray ack sends nothing', async () => {
      await idle();
      const mark = sent().length;
      await receive(ack);
      expect(sent().length).toBe(mark);
    });

    it('idle | epoch: the reports after it carry the new generation', async () => {
      await idle();
      await receive(show('a', 1));
      await settle();
      const mark = sent().length;
      await receive({ type: 'epoch', generation: 2 });
      expect(sent().slice(mark).map((report) => report.generation)).toEqual([2]);
    });

    it('idle | display applied: applied_seq never goes back', async () => {
      await idle();
      await receive(show('a', 9));
      await settle();
      await receive(show('b', 3));
      expect(sent().at(-1)?.applied_seq).toBe(9);
    });
  });

  describe('awaiting', () => {
    it('awaiting | scene: it waits for the ack, then the newest scene goes', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(show('b', 2));
      await receive(show('c', 3));
      expect(sent().length).toBe(mark);
      await receive(ack);
      expect(shownSince(mark)).toEqual([['a', 'b', 'c']]);
      expect(sent().at(-1)?.applied_seq).toBe(3);
      await receive(ack);
      expect(sent().length).toBe(mark + 1);
    });

    it('awaiting | ack with nothing queued: back to idle, nothing is sent', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(ack);
      expect(sent().length).toBe(mark);
      await receive(show('b', 2));
      expect(shownSince(mark)).toEqual([['a', 'b']]);
    });

    it('awaiting | scene equal to the report on the wire: nothing is queued', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown());
      await receive(ack);
      expect(sent().length).toBe(mark);
    });

    it('awaiting with a queued scene | the scene goes back to the report on the wire: today the queued one still goes', async () => {
      await awaiting();
      const mark = sent().length;
      const onTheWire = sent().at(-1);
      // The agent's `view` moves the screen and moves it back within one
      // round trip; `view` frames carry no seq, so the report comes back to
      // the one on the wire.
      await receive({ type: 'view', target: 'comms', reason: '' });
      await receive({ type: 'view', target: 'auto', reason: '' });
      await receive(ack);
      // Today: the page shows what `onTheWire` says, and the report after the
      // ack still says `comms`.
      expect(sent().slice(mark).map((report) => report.view)).toEqual(['comms']);
      expect(onTheWire?.view).toBe('auto');
    });

    it('awaiting | epoch: the report on the wire is given up, and the next goes without an ack', async () => {
      await awaiting();
      const mark = sent().length;
      await receive({ type: 'epoch', generation: 2 });
      expect(sent().slice(mark)).toHaveLength(1);
      expect(sent().at(-1)).toMatchObject({ generation: 2, object_ids: [] });
    });

    it('awaiting | no ack: every later report waits behind it', async () => {
      await awaiting();
      const mark = sent().length;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await receive(show('b', 2));
      expect(sent().length).toBe(mark);
    });

    it('awaiting | line down, then a new connection and its epoch: reports go without the old ack', async () => {
      await awaiting();
      const mark = sent().length;
      await lineDown();
      await receive(show('b', 2));
      await reconnect();
      await receive({ type: 'epoch', generation: 1 }, status);
      await settle();
      expect(socket()).not.toBe(FakeSocket.all[0]);
      expect(socket().reports().length).toBeGreaterThan(0);
      expect(sent().slice(mark).every((report) => report.generation === 1)).toBe(true);
    });
  });

  describe('rejections', () => {
    it('awaiting | display rejected: the rejection goes on the report after the ack, and only there', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await receive(show('b', 6));
      await receive(ack);
      expect(sent().slice(mark).map((report) => report.rejected)).toEqual([
        { seq: 5, reason: expect.any(String) },
      ]);
      await receive(show('c', 7), ack);
      expect(shownSince(mark)).toEqual([['a', 'b'], ['a', 'b', 'c']]);
      expect(sent().at(-1)?.rejected).toBeUndefined();
    });

    it('awaiting | two rejections before the ack: today only the newer is sent (#378)', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await receive(unknown(6));
      await settle();
      await receive(show('b', 7));
      await settle();
      const rejected = sent()
        .slice(mark)
        .flatMap((report) => (report.rejected ? [(report.rejected as { seq: number }).seq] : []));
      expect(rejected).toEqual([6]);
    });

    it('awaiting with a queued rejection | a newer rejection and the ack in one task: both are sent, the older first', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await receive(unknown(6), ack);
      await settle();
      const rejected = sent()
        .slice(mark)
        .flatMap((report) => (report.rejected ? [(report.rejected as { seq: number }).seq] : []));
      expect(rejected).toEqual([5, 6]);
    });

    it('a rejection not yet sent survives an epoch', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await receive({ type: 'epoch', generation: 2 });
      expect(sent().slice(mark).map((report) => report.rejected)).toEqual([
        { seq: 5, reason: expect.any(String) },
      ]);
    });
  });

  describe('refused sends', () => {
    it('idle | scene the socket refuses: the report waits, and today it goes after the next ack', async () => {
      await idle();
      const mark = sent().length;
      socket().readyState = 0;
      await receive(show('a', 1));
      expect(sent().length).toBe(mark);
      socket().readyState = 1;
      await receive(show('b', 2));
      expect(shownSince(mark)).toEqual([['a', 'b']]);
      await receive(ack);
      // Today: the refused, older report goes after the newer one.
      expect(shownSince(mark)).toEqual([['a', 'b'], ['a']]);
    });
  });
});
