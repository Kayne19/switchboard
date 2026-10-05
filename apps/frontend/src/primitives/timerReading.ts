import type { Timer } from '../controller/types';
import { parseTimeValue, type TimeValue } from '../controller/validation';

// What a timer reads at a moment of the page clock, and how a set of timers
// is laid out for the box it is drawn in. Pure, so the boundaries (exactly
// zero, past zero, paused, a start still to come) and the layouts are
// pinned without a clock or a browser.

/** An instant's moment in epoch milliseconds, its offset applied. */
export function instantMs(time: TimeValue): number {
  return (time.dayNumber * 86_400 + time.hour * 3600 + time.minute * 60 + time.second - time.offset * 60) * 1000 + Math.floor(time.nanos / 1_000_000);
}

/** An instant's time of day as written, `HH:MM`, and ` UTC` when it was written in UTC. */
export function instantClock(value: string): string | null {
  const time = parseTimeValue(value);
  if (!time || time.form !== 'instant') return null;
  const clock = `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
  return /(?:Z|[+-]00:00)$/.test(value) ? `${clock} UTC` : clock;
}

export type TimerPhase = 'running' | 'paused' | 'done';

export interface TimerReading {
  phase: TimerPhase;
  /** The seconds the digits show: rounded up while running, so they reach zero only at the end. */
  seconds: number;
  /** Whole seconds since a done timer reached zero; 0 for any other. */
  over: number;
  /** The share of `startedAt..endsAt` gone, 0 to 1; null without a start. */
  gone: number | null;
  /** That span in whole seconds; null without a start. */
  span: number | null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * A timer at `now` (epoch ms). A running timer counts down to `endsAt` and
 * is done from the moment it is reached: at exactly `endsAt` it reads zero
 * and done. A paused one shows its `remaining`, not counted. The share gone
 * is measured over `startedAt..endsAt`, held between none and all: a start
 * still to come (the agent's clock ahead of the page's) reads as none gone,
 * and the countdown still runs to `endsAt`.
 */
export function readTimer(timer: Timer, now: number): TimerReading {
  const endsTime = parseTimeValue(timer.endsAt);
  const startTime = timer.startedAt !== undefined ? parseTimeValue(timer.startedAt) : null;
  const ends = endsTime ? instantMs(endsTime) : now;
  const start = startTime ? instantMs(startTime) : null;
  const spanMs = start !== null && ends > start ? ends - start : null;
  const span = spanMs !== null ? Math.round(spanMs / 1000) : null;
  if (timer.state === 'paused') {
    const remaining = Math.max(0, timer.remaining ?? 0);
    return { phase: 'paused', seconds: Math.ceil(remaining), over: 0, gone: spanMs !== null ? clamp01(1 - (remaining * 1000) / spanMs) : null, span };
  }
  const left = ends - now;
  if (left <= 0) return { phase: 'done', seconds: 0, over: Math.max(0, Math.floor(-left / 1000)), gone: spanMs !== null ? 1 : null, span };
  return { phase: 'running', seconds: Math.ceil(left / 1000), over: 0, gone: spanMs !== null && start !== null ? clamp01((now - start) / spanMs) : null, span };
}

const two = (value: number) => String(value).padStart(2, '0');

/** Seconds as a countdown reads them: `MM:SS`, `H:MM:SS` from an hour, `ND HH:MM:SS` from a day. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}D ${two(hours)}:${two(minutes)}:${two(rest)}`;
  if (hours > 0) return `${hours}:${two(minutes)}:${two(rest)}`;
  return `${two(minutes)}:${two(rest)}`;
}

// ---- layout ------------------------------------------------------------------

/** A digit's advance in the mono face, as a share of its size. */
export const DIGIT_ADVANCE = 0.62;
/** The least digit size a timer's own cell is drawn with; below it the timers are listed. */
export const MIN_CELL_DIGITS = 30;
/** The largest a countdown is drawn. */
export const MAX_CELL_DIGITS = 200;
/** The least width of a cell beside another: its label stays readable. */
export const MIN_CELL_WIDTH = 200;
/** The height a cell spends on its label, bar and meta line, beside the digits. */
export const CELL_CHROME = 78;
/** The gap between cells. */
export const CELL_GAP = 20;

export type TimerLayout =
  | { kind: 'grid'; columns: number; rows: number; digits: number }
  | { kind: 'list' };

/**
 * How `count` timers whose longest countdown is `chars` characters are laid
 * out in a box: in a grid of cells, as many columns as give the largest
 * digits (the fewest on a tie) with no cell beside another narrower than
 * MIN_CELL_WIDTH, each countdown as large as its cell allows; or, where no
 * grid gives digits of MIN_CELL_DIGITS, as a list of rows that scrolls
 * when it must.
 */
export function timerLayout(width: number, height: number, count: number, chars: number): TimerLayout {
  if (width <= 0 || height <= 0 || count <= 0) return { kind: 'list' };
  let best: { columns: number; rows: number; digits: number } | null = null;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - CELL_GAP * (columns - 1)) / columns;
    if (columns > 1 && cellWidth < MIN_CELL_WIDTH) break;
    const cellHeight = (height - CELL_GAP * (rows - 1)) / rows;
    const digits = Math.min(MAX_CELL_DIGITS, cellWidth / (Math.max(1, chars) * DIGIT_ADVANCE), (cellHeight - CELL_CHROME) / 1.1);
    if (!best || digits > best.digits + 0.5) best = { columns, rows, digits };
  }
  if (!best || best.digits < MIN_CELL_DIGITS) return { kind: 'list' };
  return { kind: 'grid', columns: best.columns, rows: best.rows, digits: Math.floor(best.digits) };
}
