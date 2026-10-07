import { parseTimeValue, type TimeValue } from '../controller/validation';

// How the page writes a date or a time of day: the one namer of days,
// months and clocks, for every view that shows a time (docs/display-tool.md,
// "Time values"). A date or a wall time the agent sent is written as sent,
// with no zone maths and no page clock. "Today" is the object's own
// `today`, so a label reads the same on every screen. Read through
// `parseTimeValue`, the one time parser the page has.

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/** A day as the page names it: its day number (days from 1970-01-01) and
 * its date. A parsed time is one, and so is a calendar's day. */
export type CivilDay = Pick<TimeValue, 'dayNumber' | 'year' | 'month' | 'day'>;

/** A number written with two digits at least: `07`. */
export const two = (value: number) => String(value).padStart(2, '0');

/** The day of the week of a day number, Sunday 0 (1970-01-01, day 0, was a Thursday). */
export function weekdayOf(dayNumber: number): number {
  return (((dayNumber + 4) % 7) + 7) % 7;
}

/** `WED`. */
export function weekdayName(dayNumber: number): string {
  return WEEKDAYS[weekdayOf(dayNumber)];
}

/** `OCT`, from the month's number (1 is January). */
export function monthName(month: number): string {
  return MONTHS[month - 1] ?? '';
}

/** `09:30`, 24 h, from minutes into a day (1440 is `24:00`, the day's end). */
export function clockText(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  return `${two(hours)}:${two(minuteOfDay - hours * 60)}`;
}

/** A time's time of day as written: `08:12`. */
export function timeOfDay(time: { hour: number; minute: number }): string {
  return clockText(time.hour * 60 + time.minute);
}

/**
 * A day: `TUE OCT 6`, its weekday and date. A day in another year than
 * `today`'s gives its year instead of its weekday (`DEC 30 2025`), so a
 * label stays short and a day from last December does not read as this
 * one's. With no `today` there is no year to set it against, and the label
 * is the weekday and date alone: the agent that leaves `today` out has not
 * said which year the reader is in.
 */
export function dayText(day: CivilDay, today?: { year: number } | null): string {
  const month = monthName(day.month);
  if (today && today.year !== day.year) return `${month} ${day.day} ${day.year}`;
  return `${weekdayName(day.dayNumber)} ${month} ${day.day}`;
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
