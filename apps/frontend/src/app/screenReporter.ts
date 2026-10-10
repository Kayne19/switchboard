// The page's screen-state reports: what it shows, told to the service as
// `screen_state` frames (docs/visual-channel.md, "The browser's report").
//
// Stop-and-wait: one report is on the wire until its `screen_state_ack`, and
// the newest scene waits behind it. A display the page declines is reported
// once, on the next report that goes out. `ScreenReporter` is the one owner of
// that line; its phase x event table is in apps/frontend/ARCHITECTURE.md
// ("Screen reports") and pinned by tests/unit/screenReporter.test.tsx.

import type { ControllerState, ScreenStateReport } from "../controller/types";
import { deriveScreenState } from "./sceneModel";

/** A display the page declined: its seq and the page's reason. */
export interface Rejection {
  seq: number;
  reason: string;
}

/** Where the report line is. Only `awaiting` has a report on the wire. */
type Line =
  /** No epoch on this connection yet, or the line went down: reports wait. */
  | { kind: "unready" }
  /** The epoch is announced and no report waits for its ack. */
  | { kind: "idle" }
  /** `report` is on the wire until its ack. */
  | { kind: "awaiting"; report: ScreenStateReport };

interface ReporterState {
  line: Line;
  /** The newest report that has not gone out: it goes on the next ack. */
  queued: ScreenStateReport | null;
  /** The generation the last `epoch` announced; every report carries it. */
  generation: number;
  /** The highest display seq the page has applied; it never goes back. */
  appliedSeq: number;
  /**
   * The rejection no report has carried out yet. Every report built while it
   * stands carries this same object, and only the one actually sent with it
   * clears it, so a newer rejection recorded meanwhile is not cleared by an
   * older report that goes out after it.
   */
  rejection: Rejection | null;
}

/** What moves the line. */
type ReportEvent =
  | { kind: "scene"; scene: ControllerState }
  | { kind: "ack" }
  | { kind: "epoch"; generation: number }
  | { kind: "lineDown" }
  | { kind: "applied"; seq: number }
  | { kind: "rejected"; rejection: Rejection };

const UNREADY: Line = { kind: "unready" };
const IDLE: Line = { kind: "idle" };

function sameReport(a: ScreenStateReport, b: ScreenStateReport): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class ScreenReporter {
  private state: ReporterState = {
    line: UNREADY,
    queued: null,
    generation: 0,
    appliedSeq: 0,
    rejection: null,
  };

  /**
   * `transmit` puts one report on the wire and says whether it went; it
   * never calls back into the reporter.
   */
  constructor(private readonly transmit: (report: ScreenStateReport) => boolean) {}

  /** The page rendered `scene`: report it. */
  sceneChanged(scene: ControllerState): void {
    this.transition({ kind: "scene", scene });
  }

  /** The service's `screen_state_ack`. */
  acknowledged(): void {
    this.transition({ kind: "ack" });
  }

  /** The service announced `generation` on this connection. */
  epoch(generation: number): void {
    this.transition({ kind: "epoch", generation });
  }

  /** The socket is down: nothing on it will be acknowledged. */
  lineDown(): void {
    this.transition({ kind: "lineDown" });
  }

  displayApplied(seq: number): void {
    this.transition({ kind: "applied", seq });
  }

  displayRejected(seq: number, reason: string): void {
    this.transition({ kind: "rejected", rejection: { seq, reason } });
  }

  /** The only writer of `state`. */
  private transition(event: ReportEvent): void {
    this.state = this.next(this.state, event);
  }

  /**
   * The phase x event table (pinned by `screenReporter.test.tsx`): the state
   * `event` moves the line to. Sending a report is the one thing it does on
   * the way, through `transmit`, which never calls back.
   */
  private next(state: ReporterState, event: ReportEvent): ReporterState {
    const line = state.line;
    switch (event.kind) {
      case "scene": {
        const report = this.build(state, event.scene);
        switch (line.kind) {
          case "unready":
            return { ...state, queued: report };
          case "idle":
            return this.offer(state, report);
          case "awaiting":
            // The report on the wire already says this.
            if (sameReport(report, line.report)) return state;
            return { ...state, queued: report };
          default:
            return unreachable(line);
        }
      }
      case "ack":
        // An ack answers a report sent after this connection's epoch.
        if (line.kind === "unready") return state;
        if (!state.queued) return { ...state, line: IDLE };
        return this.offer({ ...state, queued: null }, state.queued);
      case "epoch":
        // A report on the wire is for the generation this replaces: it is
        // given up, and the next scene goes at once.
        return { ...state, line: IDLE, queued: null, generation: event.generation };
      case "lineDown":
        return line.kind === "unready" ? state : { ...state, line: UNREADY };
      case "applied":
        return { ...state, appliedSeq: Math.max(state.appliedSeq, event.seq) };
      case "rejected":
        return { ...state, rejection: event.rejection };
      default:
        return unreachable(event);
    }
  }

  /** The report of `scene`, carrying the applied seq and the standing rejection. */
  private build(state: ReporterState, scene: ControllerState): ScreenStateReport {
    const report = deriveScreenState(scene, state.generation);
    report.applied_seq = state.appliedSeq;
    if (state.rejection) report.rejected = state.rejection;
    return report;
  }

  /** Puts `report` on the wire; one the socket refuses waits as the queued one. */
  private offer(state: ReporterState, report: ScreenStateReport): ReporterState {
    if (!this.transmit(report)) return { ...state, line: IDLE, queued: report };
    const carried = state.rejection !== null && report.rejected === state.rejection;
    return {
      ...state,
      line: { kind: "awaiting", report },
      rejection: carried ? null : state.rejection,
    };
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled screen report case: ${JSON.stringify(value)}`);
}
