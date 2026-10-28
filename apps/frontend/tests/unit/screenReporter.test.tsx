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
import { FakeSocket } from './fakeSocket';

type Report = Record<string, unknown> & { object_ids?: string[] };

let host: HTMLDivElement;
let root: Root;

const reports = (each: FakeSocket) => each.sentOfType('screen_state') as unknown as Report[];

function socket(): FakeSocket {
  return FakeSocket.latest();
}

async function receive(...messages: object[]) {
  await act(async () => {
    for (const message of messages) socket().receive(message);
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
    socket().open();
  });
  await receive(helloAck());
}

// Every report on every socket this page opened, oldest first.
function sent(): Report[] {
  return FakeSocket.instances.flatMap((each) => reports(each));
}

// What the reports sent since `mark` show, as object ids.
function shownSince(mark: number): string[][] {
  return sent()
    .slice(mark)
    .map((report) => report.object_ids ?? []);
}

// The seqs of the rejections the reports sent since `mark` carry, in order.
function rejectedSince(mark: number): number[] {
  return sent()
    .slice(mark)
    .flatMap((report) => (report.rejected ? [(report.rejected as { seq: number }).seq] : []));
}

// The applied seqs the reports sent since `mark` name, in order.
function appliedSince(mark: number): number[] {
  return sent()
    .slice(mark)
    .flatMap((report) => (report.applied_seq === undefined ? [] : [report.applied_seq as number]));
}

// The declined seqs some report's applied_seq reached before any of
// `reports` carried their rejection: the service would answer those
// displays rendered.
function passedBeforeCarried(reports: Report[], declined: number[]): number[] {
  const carried = new Set<number>();
  const passed = new Set<number>();
  for (const report of reports) {
    const rejected = report.rejected as { seq: number } | undefined;
    if (rejected) carried.add(rejected.seq);
    for (const seq of declined) {
      if ((report.applied_seq as number) >= seq && !carried.has(seq)) passed.add(seq);
    }
  }
  return [...passed];
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
    socket().drop();
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
  FakeSocket.install();
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

    it('unready | epoch on a fresh page: no report carries applied_seq before a display applies', async () => {
      await idle();
      expect(sent().length).toBeGreaterThan(0);
      expect(appliedSince(0)).toEqual([]);
    });

    it('idle | display applied: applied_seq never goes back on a connection', async () => {
      await idle();
      await receive(show('a', 9));
      await settle();
      await receive(show('b', 3));
      expect(sent().at(-1)?.applied_seq).toBe(9);
    });

    it('idle | line down, then a new connection: its reports carry no applied_seq until a display applies on it', async () => {
      // The next connection may reach a restarted service, which counts seqs
      // again from 0.
      await idle(4);
      await receive(show('a', 500));
      await settle();
      expect(sent().at(-1)?.applied_seq).toBe(500);
      await lineDown();
      const mark = sent().length;
      await reconnect();
      await receive({ type: 'epoch', generation: 0 }, status, { type: 'history', entries: [] });
      await settle();
      expect(sent().length).toBeGreaterThan(mark);
      expect(appliedSince(mark)).toEqual([]);
      await receive(show('b', 3));
      await settle();
      expect(appliedSince(mark)).toEqual([3]);
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

    it('awaiting with a queued scene | the scene goes back to the report on the wire: the queued one is dropped', async () => {
      await awaiting();
      const mark = sent().length;
      const onTheWire = sent().at(-1);
      // The agent's `view` moves the screen and moves it back within one
      // round trip; `view` frames carry no seq, so the report comes back to
      // the one on the wire.
      await receive({ type: 'view', target: 'comms' });
      await receive({ type: 'view', target: 'auto' });
      await receive(ack);
      // The page shows what `onTheWire` says, so nothing more goes.
      expect(onTheWire?.view).toBe('auto');
      expect(sent().length).toBe(mark);
    });

    it('awaiting | epoch: the report on the wire is given up, and the next goes without an ack', async () => {
      await awaiting();
      const mark = sent().length;
      await receive({ type: 'epoch', generation: 2 });
      expect(sent().slice(mark)).toHaveLength(1);
      expect(sent().at(-1)).toMatchObject({ generation: 2, object_ids: [] });
    });

    it('awaiting | no ack by the deadline: the report is taken as ignored, and the queued scene goes', async () => {
      // The service acknowledges no report it ignores: a tab that is not the
      // active one, another generation, a view it does not know.
      await awaiting();
      const mark = sent().length;
      await receive(show('b', 2));
      await act(async () => {
        vi.advanceTimersByTime(1_999);
      });
      expect(sent().length).toBe(mark);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(shownSince(mark)).toEqual([['a', 'b']]);
    });

    it('awaiting | no ack by the deadline and nothing queued: back to idle, the next scene goes at once', async () => {
      await awaiting();
      const mark = sent().length;
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(sent().length).toBe(mark);
      await receive(show('b', 2));
      expect(shownSince(mark)).toEqual([['a', 'b']]);
    });

    it('awaiting | the deadline of a report already acknowledged: dropped', async () => {
      await awaiting();
      const mark = sent().length;
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      await receive(ack, show('b', 2));
      expect(shownSince(mark)).toEqual([['a', 'b']]);
      // `a`'s deadline would have fired here; `b` still waits for its ack.
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      await receive(show('c', 3));
      expect(sent().length).toBe(mark + 1);
    });

    it('awaiting | line down, then a new connection and its epoch: reports go without the old ack', async () => {
      await awaiting();
      const mark = sent().length;
      await lineDown();
      await receive(show('b', 2));
      await reconnect();
      await receive({ type: 'epoch', generation: 1 }, status);
      await settle();
      expect(socket()).not.toBe(FakeSocket.instances[0]);
      expect(reports(socket()).length).toBeGreaterThan(0);
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

    it('awaiting | two rejections before the ack: both are sent, one per report, oldest first (#378)', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await receive(unknown(6));
      await settle();
      await receive(show('b', 7));
      await settle();
      expect(rejectedSince(mark)).toEqual([5, 6]);
      // Each rejection went once, and the line rests once they are out.
      expect(sent().at(-1)?.rejected).toBeUndefined();
    });

    it('awaiting | two rejections in one task: the second goes on a report of its own after the ack (#378)', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5), unknown(6));
      await receive(ack);
      expect(rejectedSince(mark)).toEqual([5]);
      await receive(ack);
      expect(rejectedSince(mark)).toEqual([5, 6]);
      await receive(ack);
      expect(sent().slice(mark)).toHaveLength(2);
    });

    it('awaiting | two rejections, then an applied display: no report says a seq is applied before its rejection is out (#378)', async () => {
      // The service answers a display call `rendered: true` once a report's
      // `applied_seq` reaches its seq with no rejection for it, so a report
      // that passes a rejection still waiting on the page would confirm it.
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await receive(unknown(6));
      await receive(show('b', 7));
      await settle();
      expect(rejectedSince(mark)).toEqual([5, 6]);
      expect(passedBeforeCarried(sent().slice(mark), [5, 6])).toEqual([]);
      expect(sent().at(-1)?.applied_seq).toBe(7);
    });

    it('awaiting | a rejection declined after a newer one: no report says a seq is applied before its rejection is out (#378)', async () => {
      // A frame can be declined out of seq order (a snapshot replayed into
      // the stage). The ceiling must hold below every rejection still
      // waiting, not only the next one in arrival order.
      await awaiting();
      const mark = sent().length;
      await receive(unknown(3), unknown(9), unknown(5));
      await receive(show('b', 10));
      await settle();
      expect(rejectedSince(mark)).toEqual([3, 5, 9]);
      expect(passedBeforeCarried(sent().slice(mark), [3, 5, 9])).toEqual([]);
      expect(sent().at(-1)?.applied_seq).toBe(10);
    });

    it('awaiting | twenty rejections at once: every one goes, one per report, lowest first (#378)', async () => {
      await awaiting();
      const mark = sent().length;
      const seqs = Array.from({ length: 20 }, (_, index) => 10 + index);
      await receive(...seqs.map((seq) => unknown(seq)));
      await settle();
      expect(rejectedSince(mark)).toEqual(seqs);
    });

    it('awaiting | twenty rejections, then an applied display: no report says a seq is applied before its rejection is out', async () => {
      // More than the service keeps (MAX_KEPT_REJECTIONS in display.rs).
      await awaiting();
      const mark = sent().length;
      const declined = Array.from({ length: 20 }, (_, index) => 10 + index);
      await receive(...declined.map((seq) => unknown(seq)));
      await receive(show('b', 30), unknown(31));
      await settle();
      expect(passedBeforeCarried(sent().slice(mark), [...declined, 31])).toEqual([]);
    });

    it('awaiting with two rejections | no ack by the deadline: the next rejection still goes (#378)', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5), unknown(6));
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(rejectedSince(mark)).toEqual([5]);
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(rejectedSince(mark)).toEqual([5, 6]);
    });

    it('awaiting with a queued rejection | a newer rejection and the ack in one task: both are sent, the older first', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await receive(unknown(6), ack);
      await settle();
      expect(rejectedSince(mark)).toEqual([5, 6]);
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

    it('a rejection not yet sent survives a reconnect, and no report passes it before it is out', async () => {
      await awaiting();
      const mark = sent().length;
      await receive(unknown(5));
      await lineDown();
      await reconnect();
      await receive({ type: 'epoch', generation: 1 }, status, show('a', 9));
      await settle();
      expect(rejectedSince(mark)).toEqual([5]);
      expect(passedBeforeCarried(sent().slice(mark), [5])).toEqual([]);
      expect(sent().at(-1)?.applied_seq).toBe(9);
    });

    it('idle | display rejected, then line down before the ack: the rejection goes again on the next connection', async () => {
      // The service may never have read the report that carried it, and its
      // display call may still wait when the same service answers again.
      await idle();
      await receive(show('a', 1));
      await settle();
      await receive(unknown(5));
      expect(sent().at(-1)?.rejected).toEqual({ seq: 5, reason: expect.any(String) });
      await lineDown();
      await reconnect();
      await receive({ type: 'epoch', generation: 1 }, status, show('a', 9));
      await settle();
      expect(passedBeforeCarried(reports(socket()), [5])).toEqual([]);
      expect(reports(socket()).at(-1)?.applied_seq).toBe(9);
    });
  });

  describe('refused sends', () => {
    it('idle | scene the socket refuses: the report waits until a newer one goes, and never goes after it', async () => {
      await idle();
      const mark = sent().length;
      socket().readyState = 0;
      await receive(show('a', 1));
      expect(sent().length).toBe(mark);
      socket().readyState = 1;
      await receive(show('b', 2));
      expect(shownSince(mark)).toEqual([['a', 'b']]);
      await receive(ack);
      expect(shownSince(mark)).toEqual([['a', 'b']]);
    });
  });
});
