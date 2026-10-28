import type {
  CalendarData,
  CalendarEvent,
} from '../types';
import { SEMANTICS, checkItemId, checkString, checkUnknownKeys, copyFrameText, copyOptionalBoolean, copyOptionalName, copyOptionalString, invalidName, isName, isRecord } from './shared';
import type { Fields } from './shared';
import { compareTimeValues, readTime } from './time';
import type { TimeValue } from './time';

const CALENDAR_VIEWS = ['day', 'week', 'month', 'agenda'];
/** The most days a view may show; the day and month views take no `days`. */
const CALENDAR_MAX_DAYS: Record<string, number> = { week: 7, agenda: 31 };
const MAX_CALENDAR_EVENTS = 200;
const CALENDAR_EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'];

function validateCalendarEvent(e: unknown, seen: Set<string>): { ok: true; event: CalendarEvent } | { ok: false; error: string } {
  if (!isRecord(e)) return { ok: false, error: 'calendar event must be an object' };
  const unknownKey = checkUnknownKeys(
    e,
    new Set(['id', 'title', 'start', 'end', 'location', 'detail', 'semantic', 'status', 'active']),
    'calendar event',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(e.id, seen, 'calendar event');
  if (!id.ok) return id;
  const titleErr = checkString(e.title, 256, 'calendar event.title');
  if (titleErr) return { ok: false, error: titleErr };
  const start = readTime(e.start, ['date', 'wall'], 'calendar event.start');
  if (!start.ok) return start;
  const out: Fields = { id: id.id, title: e.title, start: e.start };
  if (e.end !== undefined) {
    const end = readTime(e.end, ['date', 'wall'], 'calendar event.end');
    if (!end.ok) return end;
    if (end.time.form !== start.time.form) {
      return { ok: false, error: 'calendar event.end must be written like its start: both dates or both wall times' };
    }
    if (compareTimeValues(end.time, start.time) < 0) return { ok: false, error: 'calendar event.end is before its start' };
    out.end = e.end;
  }
  const err =
    copyOptionalString(e, out, 'location', 128, 'calendar event.location') ??
    copyOptionalString(e, out, 'detail', 256, 'calendar event.detail') ??
    copyOptionalName(e, out, 'semantic', SEMANTICS, 'calendar event.semantic') ??
    copyOptionalName(e, out, 'status', CALENDAR_EVENT_STATUSES, 'calendar event.status') ??
    copyOptionalBoolean(e, out, 'active', 'calendar event.active');
  if (err) return { ok: false, error: err };
  return { ok: true, event: out as unknown as CalendarEvent };
}

export function validateCalendarData(data: Fields): { ok: true; data: CalendarData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(
    data,
    new Set(['title', 'subtitle', 'context', 'caption', 'view', 'start', 'days', 'today', 'now', 'events']),
    'calendar data',
  );
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!isName(data.view, CALENDAR_VIEWS)) {
    return { ok: false, error: invalidName('calendar.view', CALENDAR_VIEWS) };
  }
  const view = data.view;
  const start = readTime(data.start, ['date'], 'calendar.start');
  if (!start.ok) return start;
  const out: Fields = { view, start: data.start };
  if (data.days !== undefined) {
    const max = CALENDAR_MAX_DAYS[view];
    if (max === undefined) return { ok: false, error: 'calendar.days applies only to the week and agenda views' };
    if (typeof data.days !== 'number' || !Number.isInteger(data.days) || data.days < 1 || data.days > max) {
      return { ok: false, error: `calendar.days must be an integer from 1 to ${max} on the ${view} view` };
    }
    out.days = data.days;
  }
  let today: TimeValue | undefined;
  if (data.today !== undefined) {
    const read = readTime(data.today, ['date'], 'calendar.today');
    if (!read.ok) return read;
    today = read.time;
    out.today = data.today;
  }
  if (data.now !== undefined) {
    const read = readTime(data.now, ['wall'], 'calendar.now');
    if (!read.ok) return read;
    if (today && read.time.dayNumber !== today.dayNumber) return { ok: false, error: 'calendar.now must fall on calendar.today' };
    out.now = data.now;
  }

  if (!Array.isArray(data.events) || data.events.length > MAX_CALENDAR_EVENTS) {
    return { ok: false, error: `calendar.events must be an array of at most ${MAX_CALENDAR_EVENTS} items` };
  }
  const seen = new Set<string>();
  const events: CalendarEvent[] = [];
  for (const e of data.events) {
    const res = validateCalendarEvent(e, seen);
    if (!res.ok) return res;
    events.push(res.event);
  }
  out.events = events;

  const err = copyFrameText(data, out, 'calendar');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as CalendarData };
}
