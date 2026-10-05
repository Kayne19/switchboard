import type { CalendarData, CalendarEvent } from '../controller/types';
import { parseTimeValue } from '../controller/validation';

// Where every part of a calendar goes (docs/display-tool.md, "calendar"),
// in plain numbers the primitive draws: the days a view shows, each event
// placed in time, a time grid's hours (the empty ones folded), the columns
// overlapping events share, the lanes of the all-day bars, a month's
// weeks and what a busy day leaves out, an agenda's days. Nothing here
// reads the page clock: "today" and "now" are the agent's (`today`,
// `now`), so a frame is the same on every screen. Times are read by the
// one parser the page has (`parseTimeValue`); a day is its `dayNumber`
// (days from 1970-01-01) and a moment is minutes from 1970-01-01 00:00 on
// the caller's wall clock, so a day's minutes run from `day * 1440`.

export const MINUTES_PER_DAY = 1440;
/** A timed event sent with no `end` is drawn as a block this long. */
export const UNTIMED_BLOCK_MINUTES = 30;

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/** A day as the calendar names it. `weekday` counts from Sunday (0). */
export interface CalendarDay {
  dayNumber: number;
  year: number;
  month: number;
  day: number;
  weekday: number;
}

/** The civil date of a day number (Howard Hinnant's civil_from_days), the
 * inverse of the parser's day count, so the views can step through days. */
export function calendarDay(dayNumber: number): CalendarDay {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { dayNumber, year, month, day, weekday: (((dayNumber + 4) % 7) + 7) % 7 };
}

export function weekdayName(dayNumber: number): string {
  return WEEKDAYS[calendarDay(dayNumber).weekday];
}

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? '';
}

/** `WED OCT 7`. */
export function dayLabel(dayNumber: number): string {
  const day = calendarDay(dayNumber);
  return `${WEEKDAYS[day.weekday]} ${MONTHS[day.month - 1]} ${day.day}`;
}

/** `09:30`, from minutes into a day (1440 is `24:00`, the day's end). */
export function clockText(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay - hours * 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ---- events in time ----------------------------------------------------------

/** An event placed in time. A timed event runs `start..end` (minutes,
 * `end` exclusive); an all-day one covers `firstDay..lastDay` whole. */
export interface PlacedEvent {
  event: CalendarEvent;
  /** Its index in `events`: the agent's order breaks every tie. */
  order: number;
  allDay: boolean;
  firstDay: number;
  /** Inclusive: the last day the event covers any of. */
  lastDay: number;
  start: number;
  end: number;
  /** Sent with no `end`: a timed event drawn as a 30-minute block. */
  openEnd: boolean;
}

/** Every event the calendar can place (the validators admit no other), in the order sent. */
export function placeEvents(events: CalendarEvent[]): PlacedEvent[] {
  const placed: PlacedEvent[] = [];
  events.forEach((event, order) => {
    const start = parseTimeValue(event.start);
    if (!start || start.form === 'instant') return;
    const end = event.end === undefined ? null : parseTimeValue(event.end);
    if (start.form === 'date') {
      const lastDay = end && end.form === 'date' ? Math.max(start.dayNumber, end.dayNumber) : start.dayNumber;
      placed.push({ event, order, allDay: true, firstDay: start.dayNumber, lastDay, start: start.dayNumber * MINUTES_PER_DAY, end: (lastDay + 1) * MINUTES_PER_DAY, openEnd: false });
      return;
    }
    const from = start.dayNumber * MINUTES_PER_DAY + start.hour * 60 + start.minute;
    const to = end && end.form === 'wall' ? Math.max(from, end.dayNumber * MINUTES_PER_DAY + end.hour * 60 + end.minute) : from + UNTIMED_BLOCK_MINUTES;
    const lastDay = to > from ? Math.floor((to - 1) / MINUTES_PER_DAY) : start.dayNumber;
    placed.push({ event, order, allDay: false, firstDay: start.dayNumber, lastDay, start: from, end: to, openEnd: end === null });
  });
  return placed;
}

/** The moment `now` names, in minutes, or undefined when there is none. */
export function nowMinutes(data: CalendarData): number | undefined {
  const now = data.now === undefined ? null : parseTimeValue(data.now);
  return now && now.form === 'wall' ? now.dayNumber * MINUTES_PER_DAY + now.hour * 60 + now.minute : undefined;
}

/** The day `today` names, else the day of `now`, else undefined. */
export function todayNumber(data: CalendarData): number | undefined {
  const today = data.today === undefined ? null : parseTimeValue(data.today);
  if (today) return today.dayNumber;
  const now = nowMinutes(data);
  return now === undefined ? undefined : Math.floor(now / MINUTES_PER_DAY);
}

/** Where an event stands against the agent's now: over (`past`), under way
 * (`current`), or neither. With no `today` nothing is past. */
export type EventTense = 'past' | 'current' | 'future';

export function eventTense(placed: PlacedEvent, today: number | undefined, now: number | undefined): EventTense {
  if (now !== undefined && !placed.allDay) {
    if (placed.end <= now && placed.end > placed.start) return 'past';
    if (placed.end === placed.start && placed.start < now) return 'past';
    if (placed.start <= now && now < placed.end) return 'current';
    return 'future';
  }
  if (today === undefined) return 'future';
  if (placed.lastDay < today) return 'past';
  if (placed.allDay && placed.firstDay <= today) return 'current';
  return 'future';
}

// ---- the days a view shows ----------------------------------------------------

/** How many days a week or an agenda lists: `days`, else 7. */
export function viewDayCount(data: CalendarData): number {
  if (data.view === 'day') return 1;
  return Math.max(1, Math.min(data.view === 'week' ? 7 : 31, Math.round(data.days ?? 7)));
}

/** Weeks start on Monday (ISO 8601): a month is laid out in Monday-first rows. */
export const WEEK_STARTS_ON = 1;

export interface MonthGrid {
  year: number;
  month: number;
  /** Rows of seven day numbers, Monday first, covering the month whole. */
  weeks: number[][];
}

export function monthGrid(startDay: number): MonthGrid {
  const anchor = calendarDay(startDay);
  const first = startDay - (anchor.day - 1);
  let length = 28;
  while (calendarDay(first + length).month === anchor.month) length += 1;
  const lead = (calendarDay(first).weekday - WEEK_STARTS_ON + 7) % 7;
  const rows = Math.ceil((lead + length) / 7);
  const weeks = Array.from({ length: rows }, (_, row) => Array.from({ length: 7 }, (_, column) => first - lead + row * 7 + column));
  return { year: anchor.year, month: anchor.month, weeks };
}

/** The days a view shows, first to last: a day, a week's columns, an
 * agenda's days, or every day of a month's rows. */
export function shownDays(data: CalendarData): number[] {
  const start = parseTimeValue(data.start)?.dayNumber ?? 0;
  if (data.view === 'month') return monthGrid(start).weeks.flat();
  return Array.from({ length: viewDayCount(data) }, (_, index) => start + index);
}

/** Events that touch none of `days`: the agent sent them, and the view does not reach them. */
export function eventsOutside(placed: PlacedEvent[], days: number[]): number {
  if (days.length === 0) return placed.length;
  const first = days[0];
  const last = days[days.length - 1];
  return placed.filter((item) => item.lastDay < first || item.firstDay > last).length;
}

// ---- the time grid (day and week) ----------------------------------------------

/** A timed event's part on one day's column: an event past midnight is
 * cut at it, each part saying it runs on from the day before or to the next. */
export interface GridSegment {
  placed: PlacedEvent;
  /** The column (an index into the days shown). */
  dayIndex: number;
  /** Minutes into the day, `end` exclusive (1440 is midnight after). */
  start: number;
  end: number;
  fromBefore: boolean;
  toAfter: boolean;
  /** The part of the day's overlapping cluster it takes: the column it starts in, how many it spans, of how many. */
  column: number;
  span: number;
  columns: number;
  /** Its cluster is drawn stepped rather than side by side: each later part
   * over the earlier ones, set in by its `column`, the earlier titles still
   * showing above it (`packColumns`). */
  stepped: boolean;
  /** In a stepped cluster, the minute a later part starts to lie over this
   * one: only what is above it shows. */
  coveredAt?: number;
}

/** Each shown day's timed parts, in order of start (then the longer first, then as sent). */
export function daySegments(placed: PlacedEvent[], days: number[]): GridSegment[][] {
  const index = new Map(days.map((day, at) => [day, at]));
  const byDay: GridSegment[][] = days.map(() => []);
  for (const item of placed) {
    if (item.allDay) continue;
    for (let day = item.firstDay; day <= item.lastDay; day += 1) {
      const at = index.get(day);
      if (at === undefined) continue;
      const dayStart = day * MINUTES_PER_DAY;
      const start = Math.max(item.start, dayStart) - dayStart;
      const end = Math.min(item.end, dayStart + MINUTES_PER_DAY) - dayStart;
      byDay[at].push({ placed: item, dayIndex: at, start, end, fromBefore: item.start < dayStart, toAfter: item.end > dayStart + MINUTES_PER_DAY, column: 0, span: 1, columns: 1, stepped: false });
    }
  }
  for (const list of byDay) list.sort((a, b) => a.start - b.start || b.end - a.end || a.placed.order - b.placed.order);
  return byDay;
}

/**
 * Lays one day's overlapping parts out. Two parts overlap when their drawn
 * boxes would: a part is drawn at least `minDuration` minutes tall, so two
 * short events back to back that would touch on screen are set apart too.
 * A cluster is a run of parts each overlapping the run so far; each part
 * takes the first column free at its start.
 *
 * Where every part of a cluster starts at least `stepGap` minutes after
 * each earlier one it overlaps (a title line on screen), the cluster is
 * stepped: each part is drawn over the ones before it, set in by its
 * column, so every title shows at the full width the day has. Otherwise
 * (two start together) the parts stand side by side, each widened over the
 * columns to its right that nothing in its time holds.
 */
export function packColumns(segments: GridSegment[], minDuration: number, stepGap = Infinity): void {
  const drawnEnd = (segment: GridSegment) => Math.max(segment.end, segment.start + minDuration);
  const overlaps = (a: GridSegment, b: GridSegment) => a.start < drawnEnd(b) && b.start < drawnEnd(a);
  let cluster: GridSegment[] = [];
  let clusterEnd = -Infinity;
  const settle = () => {
    const columns = cluster.reduce((most, segment) => Math.max(most, segment.column + 1), 0);
    const stepped = columns > 1 && cluster.every((segment, at) => cluster.slice(0, at).every((earlier) => !overlaps(earlier, segment) || segment.start - earlier.start >= stepGap));
    for (const segment of cluster) {
      segment.columns = columns;
      segment.stepped = stepped;
      const over = stepped ? cluster.filter((other) => other.column > segment.column && overlaps(other, segment)).map((other) => other.start) : [];
      segment.coveredAt = over.length > 0 ? Math.min(...over) : undefined;
      let span = 1;
      while (!stepped && segment.column + span < columns && !cluster.some((other) => other !== segment && other.column === segment.column + span && overlaps(other, segment))) {
        span += 1;
      }
      segment.span = span;
    }
    cluster = [];
    clusterEnd = -Infinity;
  };
  for (const segment of segments) {
    if (cluster.length > 0 && segment.start >= clusterEnd) settle();
    const taken = new Set(cluster.filter((other) => drawnEnd(other) > segment.start).map((other) => other.column));
    let column = 0;
    while (taken.has(column)) column += 1;
    segment.column = column;
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, drawnEnd(segment));
  }
  if (cluster.length > 0) settle();
}

/** A stretch of a time grid's axis: hours drawn to scale, or a run of
 * empty hours folded to a thin band that says which hours it holds. */
export interface AxisBand {
  kind: 'hours' | 'fold';
  /** Hours of the day, `to` exclusive. */
  from: number;
  to: number;
  top: number;
  height: number;
}

export interface TimeAxis {
  bands: AxisBand[];
  hourPx: number;
  height: number;
}

/** How a time grid is sized. The least hour keeps a half-hour block one
 * line of its title tall; past it the grid scrolls. */
export const AXIS = {
  minHourPx: 26,
  maxHourPx: 64,
  /** A folded run of empty hours. */
  foldPx: 20,
  /** The fewest empty hours folded: a shorter gap is drawn as it is. */
  foldMinHours: 3,
  /** An hour this tall or more shows every hour unfolded. */
  roomyHourPx: 34,
  /** The hours a grid with nothing timed shows. */
  emptyFrom: 8,
  emptyTo: 18,
} as const;

/**
 * The hours a time grid shows and how tall each is, for the parts drawn
 * on it and the now line, in `room` pixels: from the first hour anything
 * is in to the last; runs of `foldMinHours` empty hours or more between
 * them folded unless every hour fits at a roomy size; the hours as tall as
 * the room allows between the least and the most; and where even the most
 * leaves room, more hours on whichever side is nearer midday, so a short
 * day is not drawn as two giant blocks. Shorter than `minHourPx` an hour
 * never gets: the grid is then taller than the room and scrolls.
 */
export function timeAxis(segments: GridSegment[][], nowMinute: number | undefined, room: number): TimeAxis {
  const covered = new Array<boolean>(24).fill(false);
  const cover = (from: number, to: number) => {
    for (let hour = Math.floor(from / 60); hour < Math.min(24, Math.ceil(to / 60)); hour += 1) covered[hour] = true;
  };
  for (const list of segments) for (const segment of list) cover(segment.start, Math.max(segment.end, segment.start + 1));
  if (nowMinute !== undefined) cover(nowMinute, nowMinute + 1);
  const anything = covered.includes(true);
  let first = anything ? covered.indexOf(true) : AXIS.emptyFrom;
  let last = anything ? covered.lastIndexOf(true) : AXIS.emptyTo - 1;
  // The empty runs inside the window that may fold (none in an empty grid).
  const gaps: Array<[number, number]> = [];
  for (let hour = first; anything && hour <= last; ) {
    if (covered[hour]) {
      hour += 1;
      continue;
    }
    let end = hour;
    while (end <= last && !covered[end]) end += 1;
    if (end - hour >= AXIS.foldMinHours) gaps.push([hour, end]);
    hour = end;
  }
  const span = last + 1 - first;
  const folded = gaps.reduce((sum, [from, to]) => sum + (to - from), 0);
  const fold = folded > 0 && span * AXIS.roomyHourPx > room;
  const folds = fold ? gaps : [];
  let hours = span - (fold ? folded : 0);
  const foldHeight = folds.length * AXIS.foldPx;
  // Room to spare even at the tallest hour: take in more hours, nearer midday first.
  while (hours * AXIS.maxHourPx + foldHeight < room && (first > 0 || last < 23)) {
    const before = first > 0 ? Math.abs(first - 1 + 0.5 - 13) : Infinity;
    const after = last < 23 ? Math.abs(last + 1 + 0.5 - 13) : Infinity;
    if (after <= before) last += 1;
    else first -= 1;
    hours += 1;
  }
  const hourPx = Math.max(AXIS.minHourPx, Math.min(AXIS.maxHourPx, hours > 0 ? (room - foldHeight) / hours : AXIS.maxHourPx));
  const bands: AxisBand[] = [];
  let top = 0;
  let cursor = first;
  const push = (kind: AxisBand['kind'], from: number, to: number) => {
    if (to <= from) return;
    const height = kind === 'fold' ? AXIS.foldPx : (to - from) * hourPx;
    bands.push({ kind, from, to, top, height });
    top += height;
  };
  for (const [from, to] of folds) {
    push('hours', cursor, from);
    push('fold', from, to);
    cursor = to;
  }
  push('hours', cursor, last + 1);
  return { bands, hourPx, height: top };
}

/** Where a minute of the day lies on the axis, in pixels from its top. */
export function axisY(axis: TimeAxis, minuteOfDay: number): number {
  for (const band of axis.bands) {
    if (minuteOfDay <= band.to * 60) {
      const into = Math.max(0, minuteOfDay - band.from * 60);
      return band.top + (band.kind === 'fold' ? (into / ((band.to - band.from) * 60)) * band.height : (into / 60) * axis.hourPx);
    }
  }
  return axis.height;
}

// ---- all-day bars (the week's strip, a month's rows) ---------------------------

/** An all-day event's bar over a run of columns, in the lane it shares with none it overlaps. */
export interface DayBar {
  placed: PlacedEvent;
  /** Columns, both inclusive. */
  from: number;
  to: number;
  /** It began before the first column, or runs on past the last. */
  fromBefore: boolean;
  toAfter: boolean;
  lane: number;
}

/** The bars of the all-day events over `days` (one row of columns), each
 * in the first lane free along its run: the earlier first, then the longer. */
export function dayBars(placed: PlacedEvent[], days: number[]): DayBar[] {
  if (days.length === 0) return [];
  const first = days[0];
  const last = days[days.length - 1];
  const bars: DayBar[] = placed
    .filter((item) => item.allDay && item.lastDay >= first && item.firstDay <= last)
    .map((item) => ({
      placed: item,
      from: Math.max(item.firstDay, first) - first,
      to: Math.min(item.lastDay, last) - first,
      fromBefore: item.firstDay < first,
      toAfter: item.lastDay > last,
      lane: 0,
    }))
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || a.placed.order - b.placed.order);
  const laneEnds: number[] = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex((end) => end < bar.from);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = bar.to;
    bar.lane = lane;
  }
  return bars;
}

export function laneCount(bars: DayBar[]): number {
  return bars.reduce((most, bar) => Math.max(most, bar.lane + 1), 0);
}

// ---- a month's cells ------------------------------------------------------------

/** What one month cell draws in the lines under the day's number: its
 * timed events, and when they do not all fit, a last line counting the
 * rest (with the bars of the lanes the row has no room for). */
export interface CellPlan {
  /** How many of the day's timed events are listed. */
  timed: number;
  /** How many events the "+N MORE" line counts; 0 draws no such line. */
  more: number;
}

/**
 * How one week row of a month spends each cell's `capacity` lines. The row
 * draws its bars in the same lanes in every cell, so a bar over several
 * days lines up: every lane when that leaves each cell room for all its
 * timed events, else one lane fewer than the lines (one line is kept for
 * the count). Then each cell lists its timed events, or as many as leave a
 * last line for "+N MORE", which counts the rest and the bars of the lanes
 * not drawn over that day.
 */
export function monthRowPlan(bars: DayBar[], timedCounts: number[], capacity: number): { lanes: number; cells: CellPlan[] } {
  const rowLanes = laneCount(bars);
  const hiddenAt = (column: number, lanes: number) => bars.filter((bar) => bar.lane >= lanes && bar.from <= column && bar.to >= column).length;
  const allFit = rowLanes <= capacity && timedCounts.every((count) => count <= capacity - rowLanes);
  const lanes = allFit ? rowLanes : Math.max(0, Math.min(rowLanes, capacity - 1));
  const free = Math.max(0, capacity - lanes);
  const cells = timedCounts.map((count, column) => {
    const hidden = hiddenAt(column, lanes);
    if (hidden === 0 && count <= free) return { timed: count, more: 0 };
    const timed = Math.max(0, Math.min(count, free - 1));
    return { timed, more: count - timed + hidden };
  });
  return { lanes, cells };
}

/** The timed events that start on `day`, in order of start, then as sent. */
export function timedOn(placed: PlacedEvent[], day: number): PlacedEvent[] {
  return placed
    .filter((item) => !item.allDay && item.firstDay === day)
    .sort((a, b) => a.start - b.start || a.order - b.order);
}

// ---- the agenda ------------------------------------------------------------------

/** One event on one agenda day. */
export interface AgendaItem {
  placed: PlacedEvent;
  /** It began on an earlier day (a stay, a flight past midnight). */
  fromBefore: boolean;
  /** It runs on past this day. */
  toAfter: boolean;
  /** For an event over several days: which of them this is (from 1), and of how many. */
  dayOf: number;
  daysLong: number;
  /** Its first appearance in the list: the one a note's badge and a count name. */
  first: boolean;
}

export type AgendaEntry =
  | {
      kind: 'day';
      day: number;
      allDay: AgendaItem[];
      timed: AgendaItem[];
      /** On today, the timed item the now line stands before (`timed.length`: after all). */
      nowAt?: number;
    }
  | { kind: 'empty'; from: number; to: number };

/**
 * The agenda's days, first to last: each day's all-day events, then its
 * timed ones by start (one running on from the day before first), the now
 * line on today before the first that starts after now. A run of days
 * with nothing on them is one line; today is always a day of its own.
 */
export function agendaEntries(placed: PlacedEvent[], days: number[], today: number | undefined, now: number | undefined): AgendaEntry[] {
  const seen = new Set<PlacedEvent>();
  const entries: AgendaEntry[] = [];
  const item = (event: PlacedEvent, day: number): AgendaItem => {
    const first = !seen.has(event);
    seen.add(event);
    return { placed: event, fromBefore: event.firstDay < day, toAfter: event.lastDay > day, dayOf: day - event.firstDay + 1, daysLong: event.lastDay - event.firstDay + 1, first };
  };
  for (const day of days) {
    const touching = placed.filter((event) => event.firstDay <= day && event.lastDay >= day);
    const allDay = touching.filter((event) => event.allDay).sort((a, b) => a.firstDay - b.firstDay || a.order - b.order).map((event) => item(event, day));
    const timed = touching
      .filter((event) => !event.allDay)
      .sort((a, b) => Math.max(a.start, day * MINUTES_PER_DAY) - Math.max(b.start, day * MINUTES_PER_DAY) || a.start - b.start || a.order - b.order)
      .map((event) => item(event, day));
    if (allDay.length === 0 && timed.length === 0 && day !== today) {
      const previous = entries[entries.length - 1];
      if (previous?.kind === 'empty' && previous.to === day - 1) previous.to = day;
      else entries.push({ kind: 'empty', from: day, to: day });
      continue;
    }
    const entry: AgendaEntry = { kind: 'day', day, allDay, timed };
    if (day === today && now !== undefined && Math.floor(now / MINUTES_PER_DAY) === day) {
      const at = timed.findIndex((entryItem) => entryItem.placed.start > now);
      entry.nowAt = at < 0 ? timed.length : at;
    }
    entries.push(entry);
  }
  return entries;
}

const NOW_ROW = '\u0000now';
/** How many rows from the now line a marked event may lie for the agenda to open on the now line. */
export const NEAR_NOW_ROWS = 3;

/**
 * Where an agenda opens: on the marked event (its id), unless it lies within
 * a few rows after the now line, where the now line leads (undefined) so
 * the reader sees both; with nothing marked, the now line.
 */
export function agendaLead(entries: AgendaEntry[], marked: string | undefined): string | undefined {
  const order: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'day') continue;
    for (const item of entry.allDay) order.push(item.first ? item.placed.event.id : '');
    entry.timed.forEach((item, index) => {
      if (entry.nowAt === index) order.push(NOW_ROW);
      order.push(item.first ? item.placed.event.id : '');
    });
    if (entry.nowAt === entry.timed.length) order.push(NOW_ROW);
  }
  const markedAt = marked === undefined ? -1 : order.indexOf(marked);
  if (markedAt < 0) return undefined;
  const nowAt = order.indexOf(NOW_ROW);
  return nowAt >= 0 && nowAt < markedAt && markedAt - nowAt <= NEAR_NOW_ROWS ? undefined : marked;
}

/** Overlaps: the timed events on a day that share some of their time with another. */
export function overlapping(items: AgendaItem[]): Set<PlacedEvent> {
  const out = new Set<PlacedEvent>();
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const x = items[a].placed;
      const y = items[b].placed;
      if (x.start < y.end && y.start < x.end && x.end > x.start && y.end > y.start) {
        out.add(x);
        out.add(y);
      }
    }
  }
  return out;
}

/** The time an agenda row or an event box gives for `placed` on `day`. */
export function eventTimeText(placed: PlacedEvent, day: number): { from: string; to?: string } {
  if (placed.allDay) {
    const long = placed.lastDay - placed.firstDay + 1;
    return long > 1 ? { from: 'ALL DAY', to: `DAY ${day - placed.firstDay + 1} / ${long}` } : { from: 'ALL DAY' };
  }
  const dayStart = day * MINUTES_PER_DAY;
  const from = placed.start < dayStart ? (placed.end > dayStart + MINUTES_PER_DAY ? 'ALL DAY' : 'UNTIL') : clockText(placed.start - dayStart);
  if (placed.start < dayStart && placed.end > dayStart + MINUTES_PER_DAY) return { from, to: 'CONTINUES' };
  if (placed.start < dayStart) return { from, to: clockText(placed.end - dayStart) };
  if (placed.openEnd) return { from };
  const endDay = placed.end > placed.start ? Math.floor((placed.end - 1) / MINUTES_PER_DAY) : day;
  const to = clockText(placed.end - endDay * MINUTES_PER_DAY);
  return { from, to: endDay > day ? `${to} +${endDay - day}` : to };
}

/** The range a view covers, for its meta line: `OCT 5 - 11`, `OCT 2026`, `WED OCT 7`. */
export function rangeText(data: CalendarData): string {
  const start = parseTimeValue(data.start)?.dayNumber ?? 0;
  if (data.view === 'month') {
    const grid = monthGrid(start);
    return `${monthName(grid.month)} ${grid.year}`;
  }
  const count = viewDayCount(data);
  if (count === 1) return dayLabel(start);
  const a = calendarDay(start);
  const b = calendarDay(start + count - 1);
  return a.month === b.month ? `${monthName(a.month)} ${a.day} - ${b.day}` : `${monthName(a.month)} ${a.day} - ${monthName(b.month)} ${b.day}`;
}

/** An event as a note's TARGET line names it: its title and when it starts (`Dentist / WED 10:30`), or undefined when the calendar holds no such event. */
export function eventTargetText(data: CalendarData, id: string): string | undefined {
  const placed = placeEvents(data.events).find((item) => item.event.id === id);
  if (!placed) return undefined;
  const day = Math.floor(placed.start / MINUTES_PER_DAY);
  const when = placed.allDay ? dayLabel(placed.firstDay) : `${weekdayName(day)} ${clockText(placed.start - day * MINUTES_PER_DAY)}`;
  return `${placed.event.title} / ${when}`;
}
