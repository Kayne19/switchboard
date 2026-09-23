import { describe, it, expect } from "vitest";
import {
  planReportDispatch,
  shouldClearRejectionOnSend,
  type PendingRejection,
} from "../../src/app/reportDispatch";
import type { ScreenStateReport } from "../../src/controller/types";

function baseReport(overrides: Partial<ScreenStateReport> = {}): ScreenStateReport {
  return {
    view: "comms",
    pinned: false,
    has_visual: false,
    visual_kind: null,
    object_ids: [],
    title: "",
    stale: false,
    generation: 0,
    applied_seq: 0,
    ...overrides,
  };
}

describe("planReportDispatch", () => {
  it("sends immediately when the transport is ready and nothing is in flight", () => {
    const action = planReportDispatch(baseReport(), {
      inFlightReport: null,
      transportReady: true,
      pendingRejection: null,
    });
    expect(action.kind).toBe("send");
  });

  it("queues when the transport is not ready", () => {
    const action = planReportDispatch(baseReport(), {
      inFlightReport: null,
      transportReady: false,
      pendingRejection: null,
    });
    expect(action.kind).toBe("queue");
  });

  it("queues when another report is already in flight", () => {
    const action = planReportDispatch(baseReport({ title: "new" }), {
      inFlightReport: baseReport({ title: "old" }),
      transportReady: true,
      pendingRejection: null,
    });
    expect(action.kind).toBe("queue");
  });

  it("skips when the derived report is identical to what's already in flight", () => {
    const inFlight = baseReport();
    const action = planReportDispatch(baseReport(), {
      inFlightReport: inFlight,
      transportReady: true,
      pendingRejection: null,
    });
    expect(action.kind).toBe("skip");
  });

  it("merges a pending rejection into the outgoing report without being asked to clear it", () => {
    const rejection: PendingRejection = { seq: 6, reason: "invalid diagram" };
    const action = planReportDispatch(baseReport(), {
      inFlightReport: null,
      transportReady: true,
      pendingRejection: rejection,
    });
    expect(action.kind).toBe("send");
    if (action.kind === "send") {
      expect(action.report.rejected).toEqual(rejection);
    }
  });
});

describe("shouldClearRejectionOnSend", () => {
  it("clears when the sent report carries the exact pending rejection object", () => {
    const rejection: PendingRejection = { seq: 6, reason: "invalid diagram" };
    const report = baseReport({ rejected: rejection });
    expect(shouldClearRejectionOnSend(report, rejection)).toBe(true);
  });

  it("does not clear when there is no pending rejection", () => {
    const report = baseReport();
    expect(shouldClearRejectionOnSend(report, null)).toBe(false);
  });

  it("does not clear when the pending rejection is a newer one than what's being sent (value-equal but distinct object)", () => {
    const sentRejection: PendingRejection = { seq: 6, reason: "invalid diagram" };
    const newerRejection: PendingRejection = { seq: 6, reason: "invalid diagram" };
    const report = baseReport({ rejected: sentRejection });
    expect(shouldClearRejectionOnSend(report, newerRejection)).toBe(false);
  });
});

describe("rejection survives intervening rebuilds while a report is in flight (regression)", () => {
  it("keeps a rejection alive across unrelated state changes until a report that carries it is actually sent", () => {
    // Step 1: report A is already in flight (sent earlier, no rejection).
    const reportA = baseReport({ title: "A" });

    // Step 2: a display action is rejected -- seq 6 recorded as pending.
    const rejection: PendingRejection = { seq: 6, reason: "invalid diagram" };

    // Step 3: an unrelated state change (e.g. a transcript line) fires the
    // report-build effect again while A is still in flight. The rejection
    // must be merged in and queued -- not dropped.
    const planB = planReportDispatch(baseReport({ title: "B" }), {
      inFlightReport: reportA,
      transportReady: true,
      pendingRejection: rejection,
    });
    expect(planB.kind).toBe("queue");
    if (planB.kind !== "queue") throw new Error("unreachable");
    const queuedB = planB.report;
    expect(queuedB.rejected).toEqual(rejection);

    // Step 4: a second, unrelated state change fires the effect again
    // before A's ack arrives. Before the fix, the rejection would have
    // already been cleared when it was merged into `queuedB`, so this
    // rebuild would silently drop it. It must still be pending here.
    const planC = planReportDispatch(baseReport({ title: "C" }), {
      inFlightReport: reportA,
      transportReady: true,
      pendingRejection: rejection,
    });
    expect(planC.kind).toBe("queue");
    if (planC.kind !== "queue") throw new Error("unreachable");
    const queuedC = planC.report;
    expect(queuedC.rejected).toEqual(rejection);

    // Step 5: A's ack arrives. The queue holds the latest report (C, which
    // superseded B), and it is sent directly. It still carries the
    // rejection, so the nack reaches the backend at least once.
    expect(shouldClearRejectionOnSend(queuedC, rejection)).toBe(true);
  });
});
