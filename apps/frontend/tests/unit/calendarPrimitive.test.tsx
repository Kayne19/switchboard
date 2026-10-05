// @vitest-environment jsdom
// The calendar primitive (primitives/CalendarPrimitive.tsx) in each view
// and in the boxes it is given: a week's overlapping events side by side,
// an event past midnight cut on both days, cancelled struck, tentative
// dashed, the active one lit, today's column and the now line from the
// data, a week too narrow for seven columns paging through them, a grid
// too short becoming the agenda, a month too small for titles marking its
// days, and the note's item marked once wherever the event is drawn.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CalendarData } from '../../src/controller/types';
import { CalendarPrimitive, chooseLayout } from '../../src/primitives/CalendarPrimitive';
import { assistantAgenda, assistantAgendaWeek, assistantDay, assistantMonth, assistantWeek } from '../../src/fixtures/scenes';

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let bodySize = { width: 0, height: 0 };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom lays nothing out: the calendar's body reports the size a test gives it.
  const sized = (axis: 'width' | 'height') => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('calendar__body') ? bodySize[axis] : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', sized('width'));
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', sized('height'));
});

afterEach(() => {
  const rendered = root;
  if (rendered) act(() => rendered.unmount());
  host?.remove();
  root = null;
  host = null;
  bodySize = { width: 0, height: 0 };
});

function render(data: CalendarData, marked?: string, size = { width: 0, height: 0 }): HTMLElement {
  bodySize = size;
  host = document.createElement('div');
  document.body.append(host);
  const pageRoot = createRoot(host);
  root = pageRoot;
  act(() => pageRoot.render(<CalendarPrimitive data={data} marked={marked} />));
  return host.querySelector('[data-testid="calendar"]') as HTMLElement;
}

const boxes = (scope: Element, id: string) => [...scope.querySelectorAll(`[data-item="${id}"]`)];

describe('the week', () => {
  it('draws seven day columns, today\u2019s lit, with the now line in it at the agent\u2019s now', () => {
    const calendar = render(assistantWeek);
    expect(calendar.getAttribute('data-layout')).toBe('grid');
    expect(calendar.querySelectorAll('.calendar-grid__column')).toHaveLength(7);
    const today = calendar.querySelectorAll('.calendar-grid__column--today');
    expect(today).toHaveLength(1);
    expect([...calendar.querySelectorAll('.calendar-grid__column')].indexOf(today[0])).toBe(2);
    const now = calendar.querySelector('.calendar-grid__now') as HTMLElement;
    expect(now.textContent).toContain('09:40');
    expect(now.style.getPropertyValue('--now-column')).toBe('2');
  });

  it('stands two events that start together side by side, and steps one that starts a line later', () => {
    const calendar = render(assistantWeek);
    const slot = (id: string) => boxes(calendar, id)[0] as HTMLElement;
    expect(slot('planning').style.width).toContain('50%');
    expect(slot('interview').style.left).toContain('50%');
    // 13:30 starts half an hour after 13:00: a title line on the grid, so it lies over the review, set in.
    expect(slot('design-review').querySelector('.calendar-event')!.className).not.toContain('calendar-event--stepped');
    expect(slot('one-on-one').querySelector('.calendar-event')!.className).toContain('calendar-event--stepped');
  });

  it('cuts the flight at midnight, each part saying it runs on, and marks cancelled, tentative and active', () => {
    const calendar = render(assistantWeek);
    const [friday, saturday] = boxes(calendar, 'flight').map((slot) => slot.querySelector('.calendar-event')!.className);
    expect(friday).toContain('calendar-event--to-after');
    expect(saturday).toContain('calendar-event--from-before');
    expect(boxes(calendar, 'gym-thu')[0].querySelector('.calendar-event')!.className).toContain('calendar-event--cancelled');
    expect(boxes(calendar, 'homelab')[0].querySelector('.calendar-event')!.className).toContain('calendar-event--tentative');
    expect(boxes(calendar, 'standup-wed')[0].querySelector('.calendar-event')!.className).toContain('calendar-event--active');
    // Over by now: Monday's standup recedes; the dentist is still to come.
    expect(boxes(calendar, 'standup-mon')[0].querySelector('.calendar-event')!.className).toContain('calendar-event--past');
    expect(boxes(calendar, 'dentist')[0].querySelector('.calendar-event')!.className).toContain('calendar-event--future');
  });

  it('lays the all-day events in bars over their days, an end past the week pointed', () => {
    const calendar = render(assistantWeek);
    const leave = boxes(calendar, 'priya-leave')[0] as HTMLElement;
    expect(leave.className).toContain('calendar-bar--from-before');
    expect(leave.style.gridColumn).toBe('2 / 4');
    expect((boxes(calendar, 'brooklyn')[0] as HTMLElement).className).toContain('calendar-bar--to-after');
  });

  it('marks the item a note names once, on its first box, however many boxes it has', () => {
    const calendar = render(assistantWeek, 'flight');
    expect(calendar.querySelectorAll('.note-badge')).toHaveLength(1);
    expect(boxes(calendar, 'flight')[0].querySelector('.note-badge')).not.toBeNull();
    expect(render(assistantWeek, 'no-such-event').querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('pages a week too narrow for seven columns, opening on the marked event\u2019s day, the hidden days named on rails', () => {
    const calendar = render(assistantWeek, 'flight', { width: 330, height: 480 });
    expect(calendar.getAttribute('data-columns')).toBe('3');
    const heads = () => [...calendar.querySelectorAll('.calendar-grid__weekday')].map((cell) => cell.textContent);
    expect(heads()).toEqual(['FRI', 'SAT', 'SUN']);
    const rims = () => [...calendar.querySelectorAll('.calendar-pages__rim')].map((rim) => rim.textContent);
    expect(rims()).toEqual([expect.stringMatching(/^MON-THU \/ \d+ EVENTS$/)]);
    // A tap on the rail turns back a page, and is handled: the surface around it does not expand.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      calendar.querySelector('.calendar-pages__rim')!.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(heads()).toEqual(['TUE', 'WED', 'THU']);
    expect(rims()).toHaveLength(2);
  });

  it('becomes the agenda of its days in a box too short for a time grid', () => {
    const calendar = render(assistantWeek, undefined, { width: 900, height: 120 });
    expect(calendar.getAttribute('data-layout')).toBe('agenda');
    expect(calendar.querySelectorAll('.calendar-agenda__day').length + calendar.querySelectorAll('.calendar-agenda__empty').length).toBeGreaterThan(0);
  });
});

describe('the day', () => {
  it('draws one column, with the shift from last night cut at its top and the freeze cut at its bottom', () => {
    const calendar = render(assistantDay);
    expect(calendar.querySelectorAll('.calendar-grid__column')).toHaveLength(1);
    expect(boxes(calendar, 'on-call')[0].querySelector('.calendar-event')!.className).toContain('calendar-event--from-before');
    expect(boxes(calendar, 'freeze')[0].querySelector('.calendar-event')!.className).toContain('calendar-event--to-after');
  });
});

describe('the month', () => {
  it('draws the month in Monday-first rows, today\u2019s cell lit, a busy day counting what it cannot list', () => {
    const calendar = render(assistantMonth, 'dentist', { width: 900, height: 520 });
    expect(calendar.getAttribute('data-layout')).toBe('month');
    expect(calendar.querySelectorAll('.calendar-month__week')).toHaveLength(5);
    expect(calendar.querySelector('.calendar-month__cell--today')?.textContent).toContain('7');
    expect([...calendar.querySelectorAll('.calendar-more')].map((more) => more.textContent)).toContain('+3 MORE');
    // The marked line wears the badge in its time's place: a cell has no room for both.
    const dentist = boxes(calendar, 'dentist')[0];
    expect(dentist.querySelector('.note-badge')).not.toBeNull();
    expect(dentist.querySelector('.calendar-line__time')).toBeNull();
    expect(boxes(calendar, 'standup-wed')[0].querySelector('.calendar-line__time')?.textContent).toBe('09:30');
  });

  it('marks each day\u2019s events in a box too small for titles, and lists them from today under the grid', () => {
    const calendar = render(assistantMonth, 'dentist', { width: 330, height: 440 });
    expect(calendar.getAttribute('data-layout')).toBe('month-marks');
    expect(calendar.querySelector('.calendar-month__cell--today .calendar-marks')).not.toBeNull();
    expect(calendar.querySelector('.calendar-month__list .calendar-agenda__day--today')).not.toBeNull();
    // One badge: on the event's row in the list, which names it, not also on its mark.
    expect([...calendar.querySelectorAll('.note-badge')].map((badge) => badge.closest('.calendar-month__list') !== null)).toEqual([true]);
    // With no room for the list, the mark carries it.
    const small = render(assistantMonth, 'dentist', { width: 330, height: 200 });
    expect([...small.querySelectorAll('.note-badge')].map((badge) => badge.closest('.calendar-mark') !== null)).toEqual([true]);
  });
});

describe('the agenda', () => {
  it('lists today with the now line after the standup under way, and the overlaps tagged', () => {
    const calendar = render(assistantAgenda, 'dentist');
    const rows = [...calendar.querySelectorAll('.calendar-agenda__items > li')];
    const names = rows.map((row) => row.getAttribute('data-item') ?? (row.classList.contains('calendar-agenda__now') ? 'NOW' : '?'));
    expect(names).toEqual(['ana-in-town', 'standup-wed', 'NOW', 'dentist', 'design-review', 'one-on-one', 'dry-cleaning']);
    expect(calendar.querySelectorAll('.calendar-tag--overlap')).toHaveLength(2);
    // Tags follow the title on its line.
    expect(boxes(calendar, 'dentist')[0].querySelector('.calendar-agenda__line .note-badge')).not.toBeNull();
    expect(boxes(calendar, 'standup-wed')[0].querySelector('.calendar-agenda__line .calendar-tag--active')).not.toBeNull();
    // One day is one run of rows; several days may stand in columns.
    expect(calendar.querySelector('.calendar-agenda')?.className).not.toContain('calendar-agenda--days');
  });

  it('runs several days so they may stand in columns, and makes the empty days one line', () => {
    const calendar = render(assistantAgendaWeek);
    expect(calendar.querySelector('.calendar-agenda')?.className).toContain('calendar-agenda--days');
    expect([...calendar.querySelectorAll('.calendar-agenda__empty')].map((line) => line.textContent)).toEqual(['TUE OCT 13NOTHING SCHEDULED']);
  });
});

describe('the layout a box gives a view', () => {
  const week = assistantWeek;
  it('draws a view whole before its box is measured', () => {
    expect(chooseLayout(week, { width: 0, height: 0 }, 7)).toEqual({ layout: 'grid', columns: 7 });
    expect(chooseLayout(assistantMonth, { width: 0, height: 0 }, 35).layout).toBe('month');
  });
  it('keeps every column where they fit, pages them where two or more fit, and is the agenda where fewer do', () => {
    expect(chooseLayout(week, { width: 900, height: 500 }, 7)).toEqual({ layout: 'grid', columns: 7 });
    expect(chooseLayout(week, { width: 330, height: 500 }, 7)).toEqual({ layout: 'grid', columns: 3 });
    expect(chooseLayout(week, { width: 200, height: 500 }, 7).layout).toBe('agenda');
  });
  it('is the agenda where the grid under its day row and lanes would hold fewer than eight hours', () => {
    // An aux cell on a tall portrait stage: 254 px, of which the day row and two lanes take 80.
    expect(chooseLayout(week, { width: 730, height: 254 }, 7, 80).layout).toBe('agenda');
    expect(chooseLayout(week, { width: 730, height: 300 }, 7, 80).layout).toBe('grid');
  });
});
