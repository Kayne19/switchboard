import { parseTimeValue, type TimeValue } from '../controller/validation';

// How a personal-assistant view writes a date or a wall time the agent sent
// (docs/display-tool.md, "Time values"): as written, with no zone maths and
// no page clock. "Today" is the object's own `today`, so a label reads the
// same on every screen. Read through `parseTimeValue`, the one time parser
// the page has.

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

const two = (value: number) => String(value).padStart(2, '0');

/** The day of the week, from the day count (1970-01-01, day 0, was a Thursday). */
export function weekdayText(time: TimeValue): string {
  return WEEKDAYS[(((time.dayNumber + 4) % 7) + 7) % 7];
}

/** A wall time's time of day, 24 h: `08:12`. */
export function clockText(time: TimeValue): string {
  return `${two(time.hour)}:${two(time.minute)}`;
}

/**
 * A day: `TUE OCT 6`, its weekday and date. A day in another year than
 * `today`'s gives its year instead of its weekday (`DEC 30 2025`), so a
 * label stays short and never names the wrong year by leaving it out.
 */
export function dayText(time: TimeValue, today?: TimeValue | null): string {
  const month = MONTHS[time.month - 1];
  if (today && today.year !== time.year) return `${month} ${time.day} ${time.year}`;
  return `${weekdayText(time)} ${month} ${time.day}`;
}

/** Days from `today` to the day of `time`: 0 on today, -1 yesterday, 1 tomorrow. */
export function daysFrom(today: TimeValue, time: TimeValue): number {
  return time.dayNumber - today.dayNumber;
}

/** A `today` field read as a date, or null when absent or not a date. */
export function readToday(value: string | undefined): TimeValue | null {
  const today = value === undefined ? null : parseTimeValue(value);
  return today?.form === 'date' ? today : null;
}
