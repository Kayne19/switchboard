import type {
  Timer,
  TimerData,
} from '../types';
import { checkItemId, checkString, checkUnknownKeys, copyFrameText, copyOptionalName, isRecord } from './shared';
import type { Fields } from './shared';
import { compareTimeValues, readTime } from './time';

const MAX_TIMERS = 8;
/**
 * The most seconds a paused timer may have left: the span of the instants a
 * timer takes (1970 to 2199, 84,006 days), so a reading is always a time the
 * page can draw. The backend's `MAX_TIMER_REMAINING_S`.
 */
const MAX_TIMER_REMAINING_S = 7_258_118_400;
const TIMER_STATES = ['running', 'paused'];

function validateTimer(t: unknown, seen: Set<string>): { ok: true; timer: Timer } | { ok: false; error: string } {
  if (!isRecord(t)) return { ok: false, error: 'timer must be an object' };
  const unknownKey = checkUnknownKeys(t, new Set(['id', 'label', 'endsAt', 'startedAt', 'state', 'remaining']), 'timer');
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(t.id, seen, 'timer');
  if (!id.ok) return id;
  const labelErr = checkString(t.label, 128, 'timer.label');
  if (labelErr) return { ok: false, error: labelErr };
  const endsAt = readTime(t.endsAt, ['instant'], 'timer.endsAt');
  if (!endsAt.ok) return endsAt;
  const out: Fields = { id: id.id, label: t.label, endsAt: t.endsAt };
  if (t.startedAt !== undefined) {
    const startedAt = readTime(t.startedAt, ['instant'], 'timer.startedAt');
    if (!startedAt.ok) return startedAt;
    if (compareTimeValues(startedAt.time, endsAt.time) >= 0) {
      return { ok: false, error: 'timer.startedAt must be before timer.endsAt' };
    }
    out.startedAt = t.startedAt;
  }
  const stateErr = copyOptionalName(t, out, 'state', TIMER_STATES, 'timer.state');
  if (stateErr) return { ok: false, error: stateErr };
  // A running timer is counted down on the page clock; a paused one is not,
  // so it says how much is left, and a running one may not.
  const paused = t.state === 'paused';
  if (t.remaining === undefined) {
    if (paused) return { ok: false, error: 'timer.remaining is required when the timer is paused' };
  } else {
    if (!paused) return { ok: false, error: 'timer.remaining is only for a paused timer' };
    if (typeof t.remaining !== 'number' || !(t.remaining >= 0 && t.remaining <= MAX_TIMER_REMAINING_S)) {
      return { ok: false, error: `timer.remaining must be a number of seconds, 0 to ${MAX_TIMER_REMAINING_S}` };
    }
    out.remaining = t.remaining;
  }
  return { ok: true, timer: out as unknown as Timer };
}

export function validateTimerData(data: Fields): { ok: true; data: TimerData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(data, new Set(['title', 'subtitle', 'context', 'caption', 'timers']), 'timer data');
  if (unknownKey) return { ok: false, error: unknownKey };
  if (!Array.isArray(data.timers) || data.timers.length < 1 || data.timers.length > MAX_TIMERS) {
    return { ok: false, error: `timer.timers must be an array of 1 to ${MAX_TIMERS} items` };
  }
  const seen = new Set<string>();
  const timers: Timer[] = [];
  for (const t of data.timers) {
    const res = validateTimer(t, seen);
    if (!res.ok) return res;
    timers.push(res.timer);
  }
  const out: Fields = { timers };
  const err = copyFrameText(data, out, 'timer');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as TimerData };
}
