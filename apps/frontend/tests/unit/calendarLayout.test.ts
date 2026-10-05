// The calendar's layout in plain numbers (primitives/calendarLayout.ts):
// the days a view shows, events placed in time and cut at midnight,
// overlapping events in columns or stepped, a time grid's folded hours,
// the lanes of all-day bars, a month's rows and what a busy day leaves
// out, and the agenda's days. Nothing reads the page clock.
import { describe, expect, it } from 'vitest';
import type { CalendarData, CalendarEvent } from '../../src/controller/types';
import { parseTimeValue } from '../../src/controller/validation';
import {
  agendaEntries,
  AXIS,
  axisY,
  calendarDay,
  dayBars,
  daySegments,
  eventsOutside,
  eventTargetText,
  eventTense,
  eventTimeText,
  monthGrid,
  monthRowPlan,
  packColumns,
  placeEvents,
  rangeText,
  shownDays,
  timeAxis,
  type GridSegment,
} from '../../src/primitives/calendarLayout';

const day = (text: string) => parseTimeValue(text)!.dayNumber;
const event = (id: string, start: string, end?: string, more: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, title: id, start, ...(end ? { end } : {}), ...more });
const calendar = (more: Partial<CalendarData>): CalendarData => ({ view: 'week', start: '2026-10-05', events: [], ...more });

describe('days', () => {
  it('turns a day number back into the date the parser read, across the whole range', () => {
    for (let n = day('1970-01-01'); n <= day('2199-12-31'); n += 97) {
      const civil = calendarDay(n);
      const text = `${civil.year}-${String(civil.month).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}`;
      expect(parseTimeValue(text)?.dayNumber, text).toBe(n);
    }
    expect(calendarDay(day('2026-10-07'))).toMatchObject({ year: 2026, month: 10, day: 7, weekday: 3 });
    expect(calendarDay(day('2024-02-29'))).toMatchObject({ month: 2, day: 29, weekday: 4 });
  });

  it('shows a day, a week of `days` (7 when absent), an agenda of `days`, or every day of a month in Monday-first rows', () => {
    expect(shownDays(calendar({ view: 'day', start: '2026-10-07' }))).toEqual([day('2026-10-07')]);
    expect(shownDays(calendar({ days: 3 }))).toEqual([day('2026-10-05'), day('2026-10-06'), day('2026-10-07')]);
    expect(shownDays(calendar({}))).toHaveLength(7);
    expect(shownDays(calendar({ view: 'agenda', start: '2026-10-07' }))).toHaveLength(7);
    expect(shownDays(calendar({ view: 'agenda', start: '2026-10-07', days: 31 }))).toHaveLength(31);
    const october = monthGrid(day('2026-10-19'));
    expect(october.weeks).toHaveLength(5);
    expect(october.weeks[0][0]).toBe(day('2026-09-28'));
    expect(october.weeks[4][6]).toBe(day('2026-11-01'));
    for (const week of october.weeks) expect(calendarDay(week[0]).weekday).toBe(1);
    // February 2027 starts on a Monday and has four weeks; November 2026 starts on a Sunday and needs six rows.
    expect(monthGrid(day('2027-02-01')).weeks).toHaveLength(4);
    expect(monthGrid(day('2026-11-30')).weeks).toHaveLength(6);
  });

  it('names its range for the meta line', () => {
    expect(rangeText(calendar({}))).toBe('OCT 5 - 11');
    expect(rangeText(calendar({ start: '2026-09-28' }))).toBe('SEP 28 - OCT 4');
    expect(rangeText(calendar({ view: 'month', start: '2026-10-19' }))).toBe('OCT 2026');
    expect(rangeText(calendar({ view: 'day', start: '2026-10-07' }))).toBe('WED OCT 7');
  });
});

describe('events in time', () => {
  it('reads a date start as all day (a date end inclusive) and a wall time with no end as 30 minutes', () => {
    const [stay, open, flight, toMidnight] = placeEvents([
      event('stay', '2026-10-10', '2026-10-11'),
      event('open', '2026-10-07T17:30'),
      event('flight', '2026-10-09T18:05', '2026-10-10T02:40'),
      event('late', '2026-10-07T23:00', '2026-10-08T00:00'),
    ]);
    expect(stay).toMatchObject({ allDay: true, firstDay: day('2026-10-10'), lastDay: day('2026-10-11') });
    expect(open).toMatchObject({ allDay: false, openEnd: true });
    expect(open.end - open.start).toBe(30);
    expect(flight).toMatchObject({ firstDay: day('2026-10-09'), lastDay: day('2026-10-10') });
    // Ending at midnight is ending on the day it started.
    expect(toMidnight.lastDay).toBe(day('2026-10-07'));
  });

  it('cuts an event past midnight into a part on each day, each saying where it runs on', () => {
    const placed = placeEvents([event('flight', '2026-10-09T18:05', '2026-10-10T02:40')]);
    const [fri, sat] = daySegments(placed, [day('2026-10-09'), day('2026-10-10')]);
    expect(fri).toEqual([expect.objectContaining({ start: 18 * 60 + 5, end: 1440, fromBefore: false, toAfter: true })]);
    expect(sat).toEqual([expect.objectContaining({ start: 0, end: 160, fromBefore: true, toAfter: false })]);
    expect(eventTimeText(placed[0], day('2026-10-09'))).toEqual({ from: '18:05', to: '02:40 +1' });
    expect(eventTimeText(placed[0], day('2026-10-10'))).toEqual({ from: 'UNTIL', to: '02:40' });
  });

  it('is over, under way or to come by the agent\u2019s now, and with no today nothing is over', () => {
    const [standup, dentist, yesterday, trip] = placeEvents([
      event('standup', '2026-10-07T09:30', '2026-10-07T09:45'),
      event('dentist', '2026-10-07T10:30', '2026-10-07T11:30'),
      event('yesterday', '2026-10-06'),
      event('trip', '2026-10-06', '2026-10-08'),
    ]);
    const today = day('2026-10-07');
    const now = today * 1440 + 9 * 60 + 40;
    expect(eventTense(standup, today, now)).toBe('current');
    expect(eventTense(dentist, today, now)).toBe('future');
    expect(eventTense(yesterday, today, now)).toBe('past');
    expect(eventTense(trip, today, now)).toBe('current');
    expect(eventTense(yesterday, undefined, undefined)).toBe('future');
  });

  it('names an event for a note by its title and when it starts, and nothing it does not hold', () => {
    const data = calendar({ events: [event('dentist', '2026-10-07T10:30', '2026-10-07T11:30', { title: 'Dentist' }), event('ana', '2026-10-07', undefined, { title: 'Ana in town' })] });
    expect(eventTargetText(data, 'dentist')).toBe('Dentist / WED 10:30');
    expect(eventTargetText(data, 'ana')).toBe('Ana in town / WED OCT 7');
    expect(eventTargetText(data, 'nope')).toBeUndefined();
  });

  it('counts the events a view does not reach', () => {
    const placed = placeEvents([event('in', '2026-10-06T10:00'), event('before', '2026-10-01'), event('spans-in', '2026-10-01', '2026-10-05'), event('after', '2026-10-12T09:00')]);
    expect(eventsOutside(placed, shownDays(calendar({})))).toBe(2);
  });
});

describe('overlapping events', () => {
  const segmentsOf = (events: CalendarEvent[]) => daySegments(placeEvents(events), [day('2026-10-07')])[0];
  const layout = (segments: GridSegment[]) => segments.map(({ placed, column, span, columns, stepped }) => ({ id: placed.event.id, column, span, columns, stepped }));

  it('stands events that start together side by side, each widened over the free columns to its right', () => {
    const segments = segmentsOf([
      event('planning', '2026-10-07T14:00', '2026-10-07T15:30'),
      event('interview', '2026-10-07T14:00', '2026-10-07T15:00'),
      event('landlord', '2026-10-07T15:00', '2026-10-07T15:20'),
      event('later', '2026-10-07T17:00', '2026-10-07T18:00'),
    ]);
    packColumns(segments, 20, 30);
    expect(layout(segments)).toEqual([
      { id: 'planning', column: 0, span: 1, columns: 2, stepped: false },
      { id: 'interview', column: 1, span: 1, columns: 2, stepped: false },
      { id: 'landlord', column: 1, span: 1, columns: 2, stepped: false },
      { id: 'later', column: 0, span: 1, columns: 1, stepped: false },
    ]);
  });

  it('steps a cluster whose every event starts a title line below the ones it overlaps', () => {
    const segments = segmentsOf([event('review', '2026-10-07T13:00', '2026-10-07T14:00'), event('one-on-one', '2026-10-07T13:30', '2026-10-07T14:00')]);
    packColumns(segments, 20, 30);
    expect(layout(segments)).toEqual([
      { id: 'review', column: 0, span: 1, columns: 2, stepped: true },
      { id: 'one-on-one', column: 1, span: 1, columns: 2, stepped: true },
    ]);
    // Closer than a title line: side by side.
    packColumns(segments, 20, 45);
    expect(segments.every((segment) => !segment.stepped)).toBe(true);
  });

  it('sets apart two short events back to back whose drawn boxes would touch', () => {
    const segments = segmentsOf([event('a', '2026-10-07T09:30', '2026-10-07T09:45'), event('b', '2026-10-07T09:45', '2026-10-07T10:00')]);
    packColumns(segments, 10);
    expect(segments.map((segment) => segment.columns)).toEqual([1, 1]);
    packColumns(segments, 40);
    expect(segments.map((segment) => segment.column)).toEqual([0, 1]);
  });
});

describe('the time axis', () => {
  const segmentsOf = (events: CalendarEvent[]) => daySegments(placeEvents(events), [day('2026-10-07')]);

  it('runs from the first hour anything is in to the last, and folds a run of three empty hours or more', () => {
    const axis = timeAxis(segmentsOf([event('early', '2026-10-07T00:00', '2026-10-07T02:40'), event('day', '2026-10-07T09:30', '2026-10-07T23:00')]), undefined, 400);
    expect(axis.bands.map(({ kind, from, to }) => [kind, from, to])).toEqual([['hours', 0, 3], ['fold', 3, 9], ['hours', 9, 23]]);
    expect(axis.bands[1].height).toBe(AXIS.foldPx);
    expect(axisY(axis, 9 * 60)).toBe(axis.bands[2].top);
    expect(axisY(axis, 10 * 60)).toBeCloseTo(axis.bands[2].top + axis.hourPx);
  });

  it('leaves the empty hours unfolded when every hour fits at a roomy size', () => {
    const axis = timeAxis(segmentsOf([event('early', '2026-10-07T06:00', '2026-10-07T07:00'), event('late', '2026-10-07T13:00', '2026-10-07T14:00')]), undefined, 2000);
    expect(axis.bands.every((band) => band.kind === 'hours')).toBe(true);
  });

  it('takes in more hours, nearer midday first, rather than draw a short day as giant blocks', () => {
    const axis = timeAxis(segmentsOf([event('dentist', '2026-10-07T10:30', '2026-10-07T11:30')]), undefined, 600);
    expect(axis.hourPx).toBeLessThanOrEqual(AXIS.maxHourPx);
    const hours = axis.bands.reduce((sum, band) => sum + band.to - band.from, 0);
    expect(hours).toBeGreaterThanOrEqual(Math.floor(600 / AXIS.maxHourPx));
    expect(axis.bands[0].from).toBeLessThanOrEqual(10);
  });

  it('never draws an hour below the least: a long day in a short room is taller than the room, and scrolls', () => {
    const axis = timeAxis(segmentsOf([event('day', '2026-10-07T00:00', '2026-10-07T23:59')]), undefined, 200);
    expect(axis.hourPx).toBe(AXIS.minHourPx);
    expect(axis.height).toBeGreaterThan(200);
  });

  it('shows working hours on a grid with nothing timed, and the now line\u2019s hour always', () => {
    expect(timeAxis([[]], undefined, 300).bands[0]).toMatchObject({ from: AXIS.emptyFrom });
    const axis = timeAxis([[]], 21 * 60 + 15, 100);
    expect(axis.bands.some((band) => band.kind === 'hours' && band.from <= 21 && band.to > 21)).toBe(true);
  });
});

describe('all-day bars', () => {
  it('lays each bar in the first lane free along its days, saying where it runs on past the view', () => {
    const placed = placeEvents([
      event('leave', '2026-10-01', '2026-10-06'),
      event('ana', '2026-10-07', '2026-10-08'),
      event('mom', '2026-10-08'),
      event('trip', '2026-10-10', '2026-10-12'),
    ]);
    const bars = dayBars(placed, shownDays(calendar({})));
    expect(bars.map(({ placed: { event: e }, from, to, lane, fromBefore, toAfter }) => ({ id: e.id, from, to, lane, fromBefore, toAfter }))).toEqual([
      { id: 'leave', from: 0, to: 1, lane: 0, fromBefore: true, toAfter: false },
      { id: 'ana', from: 2, to: 3, lane: 0, fromBefore: false, toAfter: false },
      { id: 'mom', from: 3, to: 3, lane: 1, fromBefore: false, toAfter: false },
      { id: 'trip', from: 5, to: 6, lane: 0, fromBefore: false, toAfter: true },
    ]);
  });
});

describe('a busy month day', () => {
  it('lists what fits and counts the rest, the bars of the lanes it cannot draw included', () => {
    const week = monthGrid(day('2026-10-14')).weeks[2];
    const placed = placeEvents([event('conference', '2026-10-15', '2026-10-17'), event('talk-day', '2026-10-16')]);
    const bars = dayBars(placed, week);
    // Room for all: every lane, every event.
    expect(monthRowPlan(bars, [0, 0, 7, 0, 1, 0, 0], 10)).toEqual({ lanes: 2, cells: [0, 0, 7, 0, 1, 0, 0].map((timed) => ({ timed, more: 0 })) });
    // Four lines: the lanes stay, Wednesday lists one and counts six.
    expect(monthRowPlan(bars, [0, 0, 7, 0, 1, 0, 0], 4).cells[2]).toEqual({ timed: 1, more: 6 });
    // Two lines: one lane, and the day under the second lane counts its bar.
    const tight = monthRowPlan(bars, [0, 0, 0, 0, 1, 0, 0], 2);
    expect(tight.lanes).toBe(1);
    expect(tight.cells[4]).toEqual({ timed: 0, more: 2 });
  });
});

describe('the agenda', () => {
  const days = [day('2026-10-07'), day('2026-10-08'), day('2026-10-09'), day('2026-10-10'), day('2026-10-11')];
  const placed = placeEvents([
    event('standup', '2026-10-07T09:30', '2026-10-07T09:45'),
    event('dentist', '2026-10-07T10:30', '2026-10-07T11:30'),
    event('flight', '2026-10-09T18:05', '2026-10-10T02:40'),
    event('trip', '2026-10-10', '2026-10-11'),
  ]);

  it('lists each day, puts the now line before the first event after now, and makes a run of empty days one line', () => {
    const entries = agendaEntries(placed, [day('2026-10-06'), ...days.slice(0, 2), ...days.slice(2)], day('2026-10-07'), day('2026-10-07') * 1440 + 9 * 60 + 40);
    expect(entries.map((entry) => entry.kind)).toEqual(['empty', 'day', 'empty', 'day', 'day', 'day']);
    const today = entries[1];
    expect(today.kind === 'day' && today.nowAt).toBe(1);
    const sat = entries[4];
    expect(sat.kind === 'day' && sat.timed.map((item) => [item.placed.event.id, item.fromBefore, item.first])).toEqual([['flight', true, false]]);
    expect(sat.kind === 'day' && sat.allDay.map((item) => [item.placed.event.id, item.dayOf, item.daysLong])).toEqual([['trip', 1, 2]]);
  });

  it('keeps today a day of its own even with nothing on it', () => {
    const entries = agendaEntries([], [day('2026-10-06'), day('2026-10-07'), day('2026-10-08')], day('2026-10-07'), undefined);
    expect(entries.map((entry) => entry.kind)).toEqual(['empty', 'day', 'empty']);
  });

  it('writes an all-day event over days as which day of how many', () => {
    expect(eventTimeText(placed[3], day('2026-10-11'))).toEqual({ from: 'ALL DAY', to: 'DAY 2 / 2' });
    expect(eventTimeText(placed[1], day('2026-10-07'))).toEqual({ from: '10:30', to: '11:30' });
  });
});
