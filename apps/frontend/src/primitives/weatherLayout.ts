import type { WeatherData, WeatherHour } from '../controller/types';
import { monoAdvance } from '../design/tokens';
import { parseTimeValue } from '../controller/validation';
import { dayText, timeOfDay, two, weekdayName } from './timeLabels';

// How a forecast is laid out for the box it is drawn in, and how its times
// and temperatures are written. Pure, so the arrangements, the thinning of
// a long hourly strip and the shared scale of the daily ranges are pinned
// without a browser. Times are drawn as the agent wrote them (one parser,
// `parseTimeValue`; no zone is converted).

/** A temperature as the page writes it: to a tenth at most, no `-0`. */
export function formatTemp(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
}

/** A forecast day as a row names it, short: `WED 7`. */
export function dayShort(date: string): string {
  const time = parseTimeValue(date);
  return time ? `${weekdayName(time.dayNumber)} ${time.day}` : date;
}

/** A forecast day in full, as the page names a day (`dayText`): `THU OCT 8`. */
export function dayLong(date: string): string {
  const time = parseTimeValue(date);
  return time ? dayText(time) : date;
}

/** A forecast hour on the strip: `14`; its day's name at midnight. */
export function hourLabel(time: string): string {
  const value = parseTimeValue(time);
  if (!value) return time;
  return value.hour === 0 && value.minute === 0 ? weekdayName(value.dayNumber) : two(value.hour);
}

/** A forecast hour in full: `THU 14:00`. */
export function hourLong(time: string): string {
  const value = parseTimeValue(time);
  return value ? `${weekdayName(value.dayNumber)} ${timeOfDay(value)}` : time;
}

/**
 * What a head that leads with the forecast's title says of its place
 * beside it: the place, or where the title names its first part as words
 * (`San Francisco` of `San Francisco, CA`, whatever their case) the rest of
 * it (`CA`), or nothing when the title names all of it. The place is said
 * once, and none of it is lost.
 */
export function placeBesideTitle(title: string | undefined, location: string): string {
  const words = (text: string) => ` ${text.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const comma = location.indexOf(',');
  const first = comma < 0 ? location : location.slice(0, comma);
  if (title === undefined || words(first).trim() === '' || !words(title).includes(words(first))) return location;
  return comma < 0 ? '' : location.slice(comma + 1).trim();
}

/** A forecast hour or day a note names, in the forecast's own words; undefined when it holds none of that name. */
export function weatherItemName(data: WeatherData, item: string): string | undefined {
  const hour = (data.hourly ?? []).find((candidate) => candidate.time === item);
  if (hour) return hourLong(hour.time);
  const day = (data.daily ?? []).find((candidate) => candidate.date === item);
  return day ? dayLong(day.date) : undefined;
}

// ---- arrangement ---------------------------------------------------------------

/**
 * How the parts of a forecast stand in its box:
 * - `wide`: conditions now beside the days, the hours across the foot;
 * - `tall`: conditions now, the hours, then the days, down the box;
 * - `compact` (an aux cell, a small slot): conditions now on one line and
 *   one list under it -- the days, or the hours where there are no days or
 *   the note names an hour -- or, in a slot too short for a list's rows,
 *   the conditions with the days beside them as a row of columns (the
 *   outlook), as many as the room beside the conditions holds; in one too
 *   short for those columns, the conditions alone, the condition beside
 *   the temperature where the slot is too short to stack them.
 */
export type WeatherArrangement = 'wide' | 'tall' | 'compact';

export interface WeatherLayout {
  arrangement: WeatherArrangement;
  /** The hero temperature's size, CSS pixels. */
  temp: number;
  hourly: boolean;
  daily: boolean;
  /** The days as a row of columns beside the conditions, where no list fits. */
  outlook: boolean;
  /** The condition and the high and low beside the temperature, not under it: a slot too short for both. */
  inline: boolean;
  /** The alert stands on its line above the figure. A slot too short for that line and the item a note names gives the line to the item: the head carries the alert's tag, and focus shows it whole. */
  alertLine: boolean;
  /** Beside an outlook, the figure's width (outlookFigure), CSS pixels, the days taking the room it leaves; 0 where no outlook stands. */
  figure: number;
}

/** Below either, the box is a small slot. */
export const COMPACT_HEIGHT = 300;
export const COMPACT_WIDTH = 280;

/** Whether a box is a small slot: its forecast is `compact`, by its size alone. */
export function weatherCompact(width: number, height: number): boolean {
  return width < COMPACT_WIDTH || height < COMPACT_HEIGHT;
}

/** A small slot shorter than this has no room for a list under the
 * conditions: a list there would show its head and no row. The days stand
 * beside the conditions instead (the outlook); the rest is a focus away. */
export const COMPACT_LIST_HEIGHT = 200;
/** A short slot holds the outlook where it is this tall: the head and a
 * column of the outlook (a day's name, glyph, high and low) under it, and
 * an alert's line more where there is one. Shorter, the conditions stand
 * alone: a column cut at the foot is no reading. */
export const OUTLOOK_HEIGHT = 96;
/** The room an alert's line takes above the figure, and a spot line (the
 * hour a note names, `Spot`) under it, with their gaps. */
export const ALERT_LINE = 30;
export const SPOT_LINE = 32;
/** A short slot lower than this (an alert's line more where there is one)
 * sets the condition beside the temperature: stacked under it, the figure
 * would run past the slot's foot. */
export const STACKED_HERO_HEIGHT = 72;
/** A small slot shorter than this has no room for the hourly strip under
 * the conditions (the strip's rows need 120px); it shows the days. */
export const COMPACT_STRIP_HEIGHT = 260;
/** The head and the figure set on one line under it (`inline`): the least
 * a short slot holds of the conditions. */
export const INLINE_HERO_HEIGHT = 52;
/** The least a figure beside an outlook is drawn at: a compact figure's
 * least. A slot whose columns would leave the figure smaller holds no
 * outlook. */
export const OUTLOOK_TEMP_LEAST = 26;
/** The hourly strip's height down the box (`tall`), and its least where it
 * grows into the box's room (no days under it). The stylesheet takes it
 * from the field's style. */
export const STRIP_LEAST = 172;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function weatherLayout(
  width: number,
  height: number,
  // `ahead`: the days an outlook would show (outlookOffer), where they are
  // not all of `daily`; `markedDay`/`markedHour`: a note names one; `temp`:
  // the figure's temperature as written (formatTemp), and `condition` the
  // width its condition line is drawn at (CSS pixels, read from the page:
  // its face follows the stage), for the room a figure leaves an outlook.
  has: { hourly: boolean; daily: boolean; ahead?: boolean; markedHour?: boolean; markedDay?: boolean; alert?: boolean; temp: string; condition: number },
): WeatherLayout {
  const alertLine = has.alert === true;
  const none = { outlook: false, inline: false, alertLine, figure: 0 };
  if (weatherCompact(width, height)) {
    const temp = Math.round(clamp(Math.min(width * 0.13, height * 0.22), 26, 48));
    // Before the box is measured (0) it is drawn whole, as it is in a test.
    if (height > 0 && height < COMPACT_LIST_HEIGHT) {
      // Beside an outlook the figure is fitted to the slot less one column,
      // and the days take the room it leaves: none where the figure, as
      // wide as its temperature row or its condition line, leaves no
      // column, or would be drawn smaller than a compact figure's least.
      const fitted = heroTempFit(width - OUTLOOK_SPACE - OUTLOOK_COLUMN, has.temp, temp);
      const figure = outlookFigure(fitted, has.temp, has.condition);
      const beside = (has.ahead ?? has.daily) === true && fitted >= OUTLOOK_TEMP_LEAST && width - OUTLOOK_SPACE - figure >= OUTLOOK_COLUMN;
      // What stands above and under the figure: an alert's line, and the
      // spot line of an hour a note names (no list here draws it), or of a
      // day where the outlook does not stand.
      const plan = (alert: boolean): WeatherLayout => {
        const above = alert ? ALERT_LINE : 0;
        const outlook = beside && height >= OUTLOOK_HEIGHT + above + (has.markedHour ? SPOT_LINE : 0);
        const spot = has.markedHour === true || (has.markedDay === true && !outlook);
        const inline = height < STACKED_HERO_HEIGHT + above + (spot ? SPOT_LINE : 0);
        return { arrangement: 'compact', temp: outlook ? fitted : temp, hourly: false, daily: false, outlook, inline, alertLine: alert, figure: outlook ? figure : 0 };
      };
      // A slot too short for the head, the alert's line, the figure on one
      // line and the line of the item a note names gives the alert's line
      // to the item: the card on screen names the item, so the item is
      // what stays.
      const spotted = has.markedHour === true || has.markedDay === true;
      return plan(alertLine && !(spotted && height < INLINE_HERO_HEIGHT + ALERT_LINE + SPOT_LINE));
    }
    const hourly = has.hourly && (!has.daily || has.markedHour === true) && (height === 0 || height >= COMPACT_STRIP_HEIGHT);
    if (!hourly && !has.daily) return { arrangement: 'compact', temp, hourly: false, daily: false, ...none };
    return { arrangement: 'compact', temp, hourly, daily: has.daily && !hourly, ...none };
  }
  // Conditions alone stand larger: nothing else shares the box.
  if (!has.hourly && !has.daily) {
    return { arrangement: width >= 1.3 * height && width >= 620 ? 'wide' : 'tall', temp: Math.round(clamp(Math.min(width * 0.12, height * 0.26), 56, 160)), hourly: false, daily: false, ...none };
  }
  if (width >= 1.3 * height && width >= 620) {
    return { arrangement: 'wide', temp: Math.round(clamp(Math.min(width * 0.075, height * 0.16), 48, 132)), hourly: has.hourly, daily: has.daily, ...none };
  }
  return { arrangement: 'tall', temp: Math.round(clamp(Math.min(width * 0.17, height * 0.1), 44, 112)), hourly: has.hourly, daily: has.daily, ...none };
}

// ---- the outlook: the days beside the conditions in a short slot ------------

/** An outlook column's width and the gap between two, and the space
 * between the figure and the first, CSS pixels: room for `THU 8`, the
 * glyph, and a high or low as long as `-12.5°`. The stylesheet takes them
 * from the body's style, so the count and the drawing agree. */
export const OUTLOOK_COLUMN = 46;
export const OUTLOOK_GAP = 6;
export const OUTLOOK_SPACE = 16;

/** How many days an outlook `width` px wide shows: whole columns, none cut at its edge. */
export function outlookCount(width: number, days: number): number {
  if (width <= 0) return 0;
  return Math.max(0, Math.min(days, Math.floor((width + OUTLOOK_GAP) / (OUTLOOK_COLUMN + OUTLOOK_GAP))));
}

/**
 * The days an outlook offers: the days to come, after the forecast's
 * `today`. A forecast with no `today` leaves the page to guess: a first day
 * whose high and low the conditions now show already (`H 68° L 54°`: today,
 * as a forecast usually opens) is taken for today and left out. A day a
 * note names stays either way, in its place.
 */
export function outlookOffer<T extends { date: string; high: number; low: number }>(
  days: T[],
  forecast: { current: { high?: number; low?: number }; today?: string },
  marked?: string,
): T[] {
  const today = parseTimeValue(forecast.today);
  if (today) {
    return days.filter((day) => day.date === marked || (parseTimeValue(day.date)?.dayNumber ?? today.dayNumber) > today.dayNumber);
  }
  const [first] = days;
  const said = first !== undefined && first.date !== marked && forecast.current.high === first.high && forecast.current.low === first.low;
  return said ? days.slice(1) : days;
}

/**
 * The days an outlook of `count` columns shows: the first, in order; where
 * a note names a day past them, that day takes the last column, so the day
 * the card names is on screen with its badge.
 */
export function outlookDays<T extends { date: string }>(days: T[], count: number, marked?: string): T[] {
  const shown = days.slice(0, Math.max(0, count));
  const named = days.find((day) => day.date === marked);
  if (!named || shown.length === 0 || shown.includes(named)) return shown;
  return [...shown.slice(0, -1), named];
}

/**
 * The hero's row in ems of its temperature: the glyph (1.1), the gap
 * (0.24), the digits (the mono face's advance, 0.6 each: their -0.04em
 * tracking, .weather-now__temp, is left as room), and the unit after them
 * (0.55). The hero sizes its temperature so the row fits its column.
 */
export function heroEms(tempText: string): number {
  return 1.1 + 0.24 + tempText.length * monoAdvance(1, 0) + 0.55;
}

/** The glyph's width beside a compact figure in ems of its temperature
 * (heroEms' first term, as its gap is its second), and the gap a compact
 * figure draws after it, CSS pixels. */
const GLYPH_EMS = 1.1;
const HERO_GAP_EMS = 0.24;
export const COMPACT_FIGURE_GAP = 10;
/** The gap between the condition and the high and low on the condition
 * line under the temperature. The stylesheet takes it from the forecast's
 * style. */
export const CONDITION_GAP = 16;

/**
 * A compact figure's width at temperature `temp`: its glyph and its
 * temperature row (heroEms), or its glyph and the condition line under the
 * temperature (`condition`, as drawn), whichever is wider. Beside an
 * outlook the figure stands this wide, and the days take the rest.
 */
export function outlookFigure(temp: number, tempText: string, condition: number): number {
  // The row's gap after the glyph is the compact figure's, not heroEms' 0.24em.
  return Math.ceil(Math.max(temp * (heroEms(tempText) - HERO_GAP_EMS) + COMPACT_FIGURE_GAP, temp * GLYPH_EMS + COMPACT_FIGURE_GAP + condition));
}

/** The hero temperature for a column `width` wide: the layout's size, or less so the row fits. */
export function heroTempFit(width: number, tempText: string, temp: number): number {
  return width > 0 ? Math.max(1, Math.min(temp, Math.floor(width / heroEms(tempText)))) : temp;
}

// ---- the hourly strip ------------------------------------------------------------

/** The strip's padding each side, so an edge column's centred label stays inside it. */
export const STRIP_PAD = 10;

/** The least room, CSS pixels, between two labelled hours on the strip. */
export const HOUR_LABEL_SPACING = 34;
const STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

/** Every how many hours a strip `width` wide holding `count` hours labels one. */
export function hourLabelStep(width: number, count: number): number {
  if (count <= 0 || width <= 0) return 1;
  const column = width / count;
  return STEPS.find((step) => step * column >= HOUR_LABEL_SPACING) ?? STEPS[STEPS.length - 1];
}

/**
 * Which hours of the strip are labelled (their time, glyph, temperature and
 * chance of rain), every `step`th: on the clock's multiples of the step when
 * the hours run one after another, else every `step`th entry. The hour a
 * note names, each midnight (where the day's name stands) and the first
 * hour are labelled too, in that order of claim; no two labels stand less
 * than a step apart, so a strip `step` was chosen for never crowds them.
 */
export function labelledHours(hours: WeatherHour[], step: number, marked?: string): boolean[] {
  const times = hours.map((hour) => parseTimeValue(hour.time));
  const minuteOf = (index: number) => {
    const time = times[index];
    return time ? time.dayNumber * 1440 + time.hour * 60 + time.minute : NaN;
  };
  const hourly = hours.every((_, index) => index === 0 || minuteOf(index) - minuteOf(index - 1) === 60);
  const regular = hours.map((_, index) => (hourly ? (times[index]?.hour ?? index) % step === 0 && (times[index]?.minute ?? 0) === 0 : index % step === 0));
  const midnights = hours.flatMap((_, index) => (times[index]?.hour === 0 && times[index]?.minute === 0 ? [index] : []));
  const claims = [hours.findIndex((hour) => hour.time === marked), ...midnights, 0].filter((index) => index >= 0 && index < hours.length);
  const placed: number[] = [];
  const clear = (index: number) => placed.every((at) => Math.abs(at - index) >= step);
  for (const index of claims) if (!placed.includes(index) && clear(index)) placed.push(index);
  for (let index = 0; index < hours.length; index += 1) if (regular[index] && clear(index)) placed.push(index);
  const labelled = hours.map(() => false);
  for (const index of placed) labelled[index] = true;
  return labelled;
}

/**
 * The span a strip's temperatures are drawn over: their range, padded, and
 * never narrower than `least` degrees (10 for F, 6 for C), so a degree's
 * wobble over a quiet day is not drawn as a mountain.
 */
export function tempScale(temps: number[], least = 0): { min: number; max: number } {
  if (temps.length === 0) return { min: 0, max: 1 };
  const low = Math.min(...temps);
  const high = Math.max(...temps);
  const pad = Math.max(1, (high - low) * 0.12, (least - (high - low)) / 2);
  return { min: low - pad, max: high + pad };
}

/** The least span of a strip's temperature scale in a forecast's units. */
export const LEAST_TEMP_SPAN = { F: 10, C: 6 } as const;

// ---- the daily list ---------------------------------------------------------------

/** The one scale every day's range is drawn on: the lowest low to the highest high. */
export function dayScale(days: Array<{ high: number; low: number }>): { min: number; max: number } {
  if (days.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...days.map((day) => Math.min(day.low, day.high)));
  const max = Math.max(...days.map((day) => Math.max(day.low, day.high)));
  return max > min ? { min, max } : { min: min - 1, max: max + 1 };
}

/** The days' own range, lowest low to highest high: what the list's head says. */
export function dayRange(days: Array<{ high: number; low: number }>): { min: number; max: number } | null {
  if (days.length === 0) return null;
  return { min: Math.min(...days.map((day) => Math.min(day.low, day.high))), max: Math.max(...days.map((day) => Math.max(day.low, day.high))) };
}

/** The least width of a day's bar, in percent of the track: a day whose low is its high still shows. */
export const LEAST_RANGE = 1.5;

/** Where a day's range stands on the shared scale, as percents of the track. */
export function rangeOnScale(day: { high: number; low: number }, scale: { min: number; max: number }): { from: number; to: number } {
  const at = (value: number) => ((value - scale.min) / (scale.max - scale.min)) * 100;
  let from = at(Math.min(day.low, day.high));
  let to = at(Math.max(day.low, day.high));
  if (to - from < LEAST_RANGE) {
    const centre = Math.min(100 - LEAST_RANGE / 2, Math.max(LEAST_RANGE / 2, (from + to) / 2));
    from = centre - LEAST_RANGE / 2;
    to = centre + LEAST_RANGE / 2;
  }
  return { from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 };
}
