import type { ScreenStateReport } from "../controller/types";

export interface PendingRejection {
  seq: number;
  reason: string;
}

export interface ReportDispatchSnapshot {
  /** The report currently awaiting a `screen_state_ack`, or null if none is in flight. */
  inFlightReport: ScreenStateReport | null;
  /** Whether the transport (iframe bridge) is ready to accept a send at all. */
  transportReady: boolean;
  /**
   * The rejection recorded from a `display` action the runtime declined to
   * apply, or null once it has actually been transmitted. Read-only here:
   * `planReportDispatch` merges it into the outgoing report but never
   * clears it -- only `shouldClearRejectionOnSend` decides that, and only
   * for the report that truly carries it out over the wire. This is what
   * keeps a rejection alive across any number of intervening effect runs
   * (unrelated state changes) while a prior report is still in flight,
   * instead of being silently dropped when a later, rejection-less report
   * is queued in its place.
   */
  pendingRejection: PendingRejection | null;
}

export type ReportDispatchAction =
  | { kind: "skip" }
  | { kind: "queue"; report: ScreenStateReport }
  | { kind: "send"; report: ScreenStateReport };

/**
 * Pure decision for what to do with a freshly-derived screen-state report.
 *
 * Merges any still-pending rejection into the report (without clearing it --
 * see `ReportDispatchSnapshot.pendingRejection`), then decides whether the
 * result should be skipped (identical to what's already in flight), queued
 * (transport not ready, or another report is already in flight), or sent
 * immediately.
 */
export function planReportDispatch(
  baseReport: ScreenStateReport,
  snapshot: ReportDispatchSnapshot,
): ReportDispatchAction {
  const report: ScreenStateReport = { ...baseReport };
  if (snapshot.pendingRejection) {
    report.rejected = snapshot.pendingRejection;
  }

  const serialized = JSON.stringify(report);
  const inFlightSerialized = snapshot.inFlightReport
    ? JSON.stringify(snapshot.inFlightReport)
    : null;

  if (serialized === inFlightSerialized) {
    return { kind: "skip" };
  }

  if (!snapshot.transportReady || snapshot.inFlightReport) {
    return { kind: "queue", report };
  }

  return { kind: "send", report };
}

/**
 * Pure decision for whether sending `report` should clear the pending
 * rejection.
 *
 * Only clears when `report.rejected` is the *same object* as the currently
 * pending rejection. That identity check matters: a report built earlier
 * (while some other report was in flight) can still be the one that
 * finally gets sent once the in-flight one is acked, even after a *newer*
 * rejection has since been recorded. In that case the outgoing report
 * carries the older rejection, and clearing the pending slot would discard
 * the newer one before it ever reaches the wire. Comparing by reference
 * (rather than by value) is what tells those two cases apart.
 */
export function shouldClearRejectionOnSend(
  report: ScreenStateReport,
  pendingRejection: PendingRejection | null,
): boolean {
  return pendingRejection !== null && report.rejected === pendingRejection;
}
