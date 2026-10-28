/**
 * How a time is written (docs/display-tool.md, "Time values"): a `date`
 * (`YYYY-MM-DD`), a `wall` time on the caller's clock (`YYYY-MM-DDTHH:MM`),
 * or an `instant` (RFC 3339 with seconds and an offset). Only a timer takes
 * an instant: it is the one thing measured against the page clock.
 */
export type TimeForm = 'date' | 'wall' | 'instant';

/** A time as `parseTimeValue` read it. Fields a form does not write are 0. */
export interface TimeValue {
  form: TimeForm;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** The fraction of a second an instant carries, in nanoseconds. */
  nanos: number;
  /** An instant's offset, in minutes east of UTC; 0 for `Z` and `-00:00`. */
  offset: number;
  /** Days from 1970-01-01 to the date as written, so 0 is a Thursday. */
  dayNumber: number;
}

const MIN_TIME_YEAR = 1970;
const MAX_TIME_YEAR = 2199;

/**
 * The three forms in one pattern, upper-case `T` and `Z` only, ASCII digits
 * only (`\d` is ASCII in a JavaScript pattern), and nothing around them. The
 * backend's `parse_time_value` reads the same text by hand.
 */
const TIME_VALUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2})))?)?$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days from 1970-01-01 to a Gregorian date (Howard Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Reads a time value, the one time parser the page has: every type that
 * carries a time goes through it, and so may a renderer. A real Gregorian
 * date in the years 1970-2199; hours 00-23 (no 24:00), minutes and seconds
 * 00-59 (no leap second); an instant's fraction 1 to 9 digits and its
 * offset `Z` or `+HH:MM`/`-HH:MM` (hours 00-23). Anything else is null.
 */
export function parseTimeValue(value: unknown): TimeValue | null {
  if (typeof value !== 'string') return null;
  const match = TIME_VALUE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_TIME_YEAR || year > MAX_TIME_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const time: TimeValue = {
    form: 'date', year, month, day, hour: 0, minute: 0, second: 0, nanos: 0, offset: 0, dayNumber: daysFromCivil(year, month, day),
  };
  if (match[4] === undefined) return time;
  time.hour = Number(match[4]);
  time.minute = Number(match[5]);
  if (time.hour > 23 || time.minute > 59) return null;
  if (match[6] === undefined) return { ...time, form: 'wall' };
  time.second = Number(match[6]);
  if (time.second > 59) return null;
  if (match[7] !== undefined) time.nanos = Number(match[7].padEnd(9, '0'));
  if (match[8] !== 'Z') {
    const hours = Number(match[10]);
    const minutes = Number(match[11]);
    if (hours > 23 || minutes > 59) return null;
    time.offset = match[9] === '-' ? -(hours * 60 + minutes) : hours * 60 + minutes;
    if (time.offset === 0) time.offset = 0; // `-00:00` is UTC, as `Z` is; never -0
  }
  return { ...time, form: 'instant' };
}

/**
 * Orders two times of one form: days for a date, minutes for a wall time,
 * and for an instant the moment it names, its offset applied.
 */
export function compareTimeValues(a: TimeValue, b: TimeValue): number {
  const place = (t: TimeValue) =>
    t.form === 'date'
      ? t.dayNumber
      : t.form === 'wall'
        ? t.dayNumber * 1440 + t.hour * 60 + t.minute
        : t.dayNumber * 86_400 + t.hour * 3600 + t.minute * 60 + t.second - t.offset * 60;
  return place(a) - place(b) || a.nanos - b.nanos;
}

const TIME_FORM_TEXT: Record<TimeForm, string> = {
  date: 'a date (YYYY-MM-DD)',
  wall: 'a wall time (YYYY-MM-DDTHH:MM)',
  instant: 'an instant (YYYY-MM-DDTHH:MM:SS with Z or an offset like -07:00)',
};

/** A field that holds a time of one of `forms`; the error names them. */
export function readTime(value: unknown, forms: TimeForm[], field: string): { ok: true; time: TimeValue } | { ok: false; error: string } {
  const time = parseTimeValue(value);
  if (time && forms.includes(time.form)) return { ok: true, time };
  return { ok: false, error: `${field} must be ${forms.map((form) => TIME_FORM_TEXT[form]).join(' or ')}, on a real day in 1970-2199` };
}
