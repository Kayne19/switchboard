// The page's screen-state reports: what it shows, told to the service as
// `screen_state` frames (docs/visual-channel.md, "The browser's report").
//
// Stop-and-wait: one report is on the wire until its `screen_state_ack`, and
// the newest scene waits behind it. The service does not acknowledge a report
// it ignores (a tab that is not the active one, another generation, a view it
// does not know), so a report unanswered for `ACK_DEADLINE_MS` is taken as
// ignored and the line moves on. Each display the page declines is reported
// once, one per report, oldest first; the page reports again while one
// waits, and no report says a seq is applied past a rejection still waiting
// (#378). `ScreenReporter` is the one owner of that line; its phase x event
// table is in apps/frontend/ARCHITECTURE.md
// ("Transport boundary") and pinned by tests/unit/screenReporter.test.tsx.

import type { ControllerState, ScreenStateReport } from "../controller/types";
import { deriveScreenState } from "./sceneModel";

/**
 * How long a report waits for its ack before the page takes it as ignored.
 * An ack comes back within one round trip; the bound only matters for a
 * report the service will never answer.
 */
const ACK_DEADLINE_MS = 2_000;

const NOTHING_APPLIED = -1;

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
  /** `report` is on the wire until its ack, or until `deadline` fires. */
  | { kind: "awaiting"; report: ScreenStateReport; deadline: ReturnType<typeof setTimeout> };

interface ReporterState {
  line: Line;
  /** The newest report that has not gone out: it goes on the next ack. */
  queued: ScreenStateReport | null;
  /** The generation the last `epoch` announced; every report carries it. */
  generation: number;
  /** The highest display seq the page has applied on this connection, or `NOTHING_APPLIED`. */
  appliedSeq: number;
  /**
   * The rejections no report has carried out yet, lowest seq first, one
   * per seq. A report carries the first; only the report actually sent
   * with it takes it off the list, so a report built earlier and sent
   * later clears nothing it did not carry.
   */
  rejections: Rejection[];
  /**
   * The scene the page last rendered at this generation: a report made only
   * to carry a waiting rejection says it.
   */
  scene: ControllerState | null;
}

/**
 * What moves the line. An ack deadline names its report, so one that fires
 * after its report's wait has ended is dropped.
 */
type ReportEvent =
  | { kind: "scene"; scene: ControllerState }
  | { kind: "ack" }
  | { kind: "ackOverdue"; report: ScreenStateReport }
  | { kind: "epoch"; generation: number }
  | { kind: "lineDown" }
  | { kind: "applied"; seq: number }
  | { kind: "rejected"; rejection: Rejection };

const UNREADY: Line = { kind: "unready" };
const IDLE: Line = { kind: "idle" };

function sameReport(a: ScreenStateReport, b: ScreenStateReport): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The one teardown: a wait the line leaves takes its deadline with it. */
function leave(from: Line, to: Line): void {
  if (from.kind === "awaiting" && from !== to) clearTimeout(from.deadline);
}

export class ScreenReporter {
  private state: ReporterState = {
    line: UNREADY,
    queued: null,
    generation: 0,
    appliedSeq: NOTHING_APPLIED,
    rejections: [],
    scene: null,
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
    const from = this.state;
    const to = this.next(from, event);
    leave(from.line, to.line);
    this.state = to;
  }

  /**
   * The phase x event table (pinned by `screenReporter.test.tsx`): the state
   * `event` moves the line to. Sending a report and arming its deadline are
   * the things it does on the way; neither calls back into the machine at
   * once.
   */
  private next(state: ReporterState, event: ReportEvent): ReporterState {
    const line = state.line;
    switch (event.kind) {
      case "scene": {
        const shown = { ...state, scene: event.scene };
        const report = this.build(shown, event.scene);
        switch (line.kind) {
          case "unready":
            return { ...shown, queued: report };
          case "idle":
            return this.offer(shown, report);
          case "awaiting":
            // The report on the wire already says this, and a queued one
            // would say what the page no longer shows.
            if (sameReport(report, line.report)) return { ...shown, queued: null };
            return { ...shown, queued: report };
          default:
            return unreachable(line);
        }
      }
      case "ack":
        // An ack answers a report sent after this connection's epoch.
        if (line.kind === "unready") return state;
        return this.waitOver(state);
      case "ackOverdue":
        // The service ignored the report. Should its ack come after all, it
        // ends the wait of the report sent after it, one report early.
        if (line.kind !== "awaiting" || line.report !== event.report) return state;
        return this.waitOver(state);
      case "epoch":
        // A report on the wire is for the generation this replaces: it is
        // given up, and the next scene goes at once. Rejections stay: their
        // seqs are the delivery's, and a same-generation epoch keeps their
        // display calls waiting.
        return { ...state, line: IDLE, queued: null, scene: null, generation: event.generation };
      case "lineDown": {
        // The service may never have read the report on the wire, so the
        // rejection it carried waits to go again.
        const lost = line.kind === "awaiting" ? line.report.rejected : undefined;
        const rejections = lost ? withRejection(state.rejections, lost) : state.rejections;
        return { ...state, line: UNREADY, appliedSeq: NOTHING_APPLIED, rejections };
      }
      case "applied":
        return { ...state, appliedSeq: Math.max(state.appliedSeq, event.seq) };
      case "rejected": {
        // Kept in seq order, so the next one waiting is the lowest and the
        // ceiling in `build` holds below every rejection still waiting, even
        // one declined after a newer seq.
        return { ...state, rejections: withRejection(state.rejections, event.rejection) };
      }
      default:
        return unreachable(event);
    }
  }

  /**
   * The report of `scene`, carrying the oldest rejection not yet sent and
   * the applied seq. The applied seq stays below the next rejection still
   * waiting: the service takes a display at or under it with no rejection
   * as rendered.
   */
  private build(state: ReporterState, scene: ControllerState): ScreenStateReport {
    const report = deriveScreenState(scene, state.generation);
    const [carried, waiting] = state.rejections;
    const applied = waiting ? Math.min(state.appliedSeq, waiting.seq - 1) : state.appliedSeq;
    if (applied !== NOTHING_APPLIED) report.applied_seq = applied;
    if (carried) report.rejected = carried;
    return report;
  }

  /**
   * No report waits any more: the queued one goes, or, while a rejection
   * waits, the scene is reported again to carry it.
   */
  private waitOver(state: ReporterState): ReporterState {
    if (state.queued) return this.offer({ ...state, queued: null }, state.queued);
    if (state.rejections.length > 0 && state.scene) return this.offer(state, this.build(state, state.scene));
    return { ...state, line: IDLE };
  }

  /**
   * Puts `report` on the wire; one the socket refuses waits as the queued
   * one. A report that goes is the newest, so nothing older stays queued.
   */
  private offer(state: ReporterState, report: ScreenStateReport): ReporterState {
    if (!this.transmit(report)) return { ...state, line: IDLE, queued: report };
    return {
      ...state,
      line: { kind: "awaiting", report, deadline: this.armDeadline(report) },
      queued: null,
      rejections: state.rejections.filter((each) => each !== report.rejected),
    };
  }

  private armDeadline(report: ScreenStateReport): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.transition({ kind: "ackOverdue", report }), ACK_DEADLINE_MS);
  }
}

/** `rejections` with `rejection` in seq order, in place of one for the same seq. */
function withRejection(rejections: Rejection[], rejection: Rejection): Rejection[] {
  const others = rejections.filter((each) => each.seq !== rejection.seq);
  return [...others, rejection].sort((a, b) => a.seq - b.seq);
}

function unreachable(value: never): never {
  throw new Error(`unhandled screen report case: ${JSON.stringify(value)}`);
}
