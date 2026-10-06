// @vitest-environment jsdom
// The calendar primitive (primitives/CalendarPrimitive.tsx) in each view
// and in the boxes it is given: a week's overlapping events side by side,
// an event past midnight cut on both days, cancelled struck, tentative
// dashed, the active one lit, today's column and the now line from the
// data, a week too narrow for seven columns paging through them, a grid
// too short becoming the agenda, a month too small for titles marking its
// days, and the note's item marked once wherever the event is drawn.
import { readFileSync } from 'node:fs';
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

function render(data: CalendarData, marked?: string, size = { width: 0, height: 0 }, framed = false): HTMLElement {
  bodySize = size;
  host = document.createElement('div');
  document.body.append(host);
  const pageRoot = createRoot(host);
  root = pageRoot;
  act(() => pageRoot.render(<CalendarPrimitive data={data} marked={marked} framed={framed} />));
  return host.querySelector('[data-testid="calendar"]') as HTMLElement;
}

const boxes = (scope: Element, id: string) => [...scope.querySelectorAll(`[data-item="${id}"]`)];

// The stylesheet's rules for exactly a selector (for `.a`, not `.a-b` or
// `.a::before`), comments out, and what they declare for a property.
const stylesheet = readFileSync(`${import.meta.dirname}/../../src/styles/index.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function rulesFor(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...stylesheet.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').some((each) => new RegExp(`^${escaped}$`).test(each.trim())))
    .map(([, , body]) => body);
}
const declared = (selector: string, property: string) =>
  rulesFor(selector).flatMap((body) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))].map((match) => match[1].trim()));

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

  it('turns the days with the arrow keys, handled so nothing else hears them', () => {
    const calendar = render(assistantWeek, undefined, { width: 330, height: 480 });
    const heads = () => [...calendar.querySelectorAll('.calendar-grid__weekday')].map((cell) => cell.textContent);
    expect(heads()).toEqual(['WED', 'THU', 'FRI']);
    const pages = calendar.querySelector('.calendar-pages') as HTMLElement;
    expect(pages.getAttribute('aria-label')).toContain('Days shown: WED-FRI');
    const key = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    act(() => {
      pages.dispatchEvent(key);
    });
    expect(key.defaultPrevented).toBe(true);
    expect(heads()).toEqual(['FRI', 'SAT', 'SUN']);
    // No later days: the key is left alone.
    const again = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    act(() => {
      pages.dispatchEvent(again);
    });
    expect(again.defaultPrevented).toBe(false);
  });

  it('opens on today when the marked event is outside the week', () => {
    const calendar = render({ ...assistantWeek, events: [...assistantWeek.events, { id: 'later', title: 'Later', start: '2026-10-20T10:00' }] }, 'later', { width: 330, height: 480 });
    expect([...calendar.querySelectorAll('.calendar-grid__weekday')].map((cell) => cell.textContent)).toEqual(['WED', 'THU', 'FRI']);
    expect(calendar.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('puts the badge on the count that holds a marked bar the strip has no lane for', () => {
    const many = Array.from({ length: 5 }, (_, at) => ({ id: `a${at}`, title: `All day ${at}`, start: '2026-10-08' }));
    const calendar = render({ ...assistantWeek, events: many }, 'a4');
    const more = calendar.querySelector('.calendar-grid__strip .calendar-more') as HTMLElement;
    expect(more.textContent).toContain('+3 MORE');
    expect(more.getAttribute('data-item')).toBe('a4');
    expect(calendar.querySelectorAll('.note-badge')).toHaveLength(1);
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

  it('puts the badge on a busy day\u2019s +N MORE when the marked event is one it counts', () => {
    const calendar = render(assistantMonth, 'book-club', { width: 900, height: 520 });
    const more = [...calendar.querySelectorAll<HTMLElement>('.calendar-more')].find((line) => line.getAttribute('data-item') === 'book-club');
    expect(more?.textContent).toContain('MORE');
    expect(calendar.querySelectorAll('.note-badge')).toHaveLength(1);
  });

  it('marks a timed event a day long on the days it covers, in a month too small for titles', () => {
    const data: CalendarData = { view: 'month', start: '2026-10-01', events: [{ id: 'conference', title: 'Conference', start: '2026-10-05T09:00', end: '2026-10-07T17:00' }] };
    const calendar = render(data, 'conference', { width: 330, height: 200 });
    expect(calendar.querySelectorAll('.calendar-mark[data-item="conference"]')).toHaveLength(3);
    expect(calendar.querySelectorAll('.note-badge')).toHaveLength(1);
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

describe('a month too small for titles', () => {
  it('lists the days under a small month in the room the grid leaves, its gap to the grid inside that room', () => {
    // 440 px: the grid's five rows at 46 px under its weekday row, and the rest for the list.
    const calendar = render(assistantMonth, 'dentist', { width: 330, height: 440 });
    const list = calendar.querySelector('.calendar-month__list') as HTMLElement;
    expect(list.style.height).toBe(`${440 - (18 + 5 * 46)}px`);
    // A margin over that height ran the list past the calendar's foot by the margin.
    expect(declared('.calendar-month__list', 'margin-top')).toEqual([]);
    expect(declared('.calendar-month__list', 'padding-top')).toHaveLength(1);
  });

  const marksOf = (calendar: HTMLElement, day: string) => {
    const cell = [...calendar.querySelectorAll('.calendar-month__cell')].find((each) => each.querySelector('.calendar-month__number')?.textContent === day && !each.className.includes('outside'));
    return [...(cell?.querySelector('.calendar-marks')?.children ?? [])].map((part) => (part.querySelector('.note-badge') ? 'NOTE' : part.className.includes('calendar-marks__more') ? part.textContent : 'mark'));
  };

  it('leads the marked day\u2019s line with the NOTE badge, the other marks after it as far as the line holds, the rest counted', () => {
    // 100 px cells, rows 44 px, no room for a list: the badge is drawn in the grid.
    const calendar = render(assistantMonth, 'dentist', { width: 700, height: 240 });
    expect(calendar.getAttribute('data-layout')).toBe('month-marks');
    expect(calendar.querySelector('.calendar-month__list')).toBeNull();
    // Wednesday the 7th: Ana's visit, the standup, the dentist, the review, the 1:1, the dry cleaning.
    expect(marksOf(calendar, '7')).toEqual(['NOTE', 'mark', 'mark', 'mark', '+2']);
    expect(calendar.querySelectorAll('.note-badge')).toHaveLength(1);
    // A narrow cell keeps the badge on its line and drops what has no room after it.
    const narrow = render(assistantMonth, 'dentist', { width: 330, height: 230 });
    expect(narrow.getAttribute('data-layout')).toBe('month-marks');
    expect(marksOf(narrow, '7')).toEqual(['NOTE']);
    expect(narrow.querySelector('.calendar-month__cell--today .calendar-marks')?.getAttribute('aria-label')).toBe('6 events');
  });

  it('is the agenda of the days it draws where its rows cannot hold a line of marks, or its cells the badge', () => {
    // Rows of 36 px hold the date and a line of marks as tall as the badge; a pixel less, the agenda.
    expect(chooseLayout(assistantMonth, { width: 700, height: 18 + 5 * 36 }, 35).layout).toBe('month-marks');
    expect(chooseLayout(assistantMonth, { width: 700, height: 18 + 5 * 36 - 1 }, 35).layout).toBe('agenda');
    // Cells too narrow for the badge: the agenda where the badge would go in the grid, not where the list under it holds it.
    expect(chooseLayout(assistantMonth, { width: 315, height: 230 }, 35).layout).toBe('month-marks');
    expect(chooseLayout(assistantMonth, { width: 315, height: 230 }, 35, undefined, true).layout).toBe('agenda');
    expect(chooseLayout(assistantMonth, { width: 315, height: 360 }, 35, undefined, true).layout).toBe('month-marks');
    const calendar = render(assistantMonth, 'dentist', { width: 700, height: 160 });
    expect(calendar.getAttribute('data-layout')).toBe('agenda');
    // Every day the month draws, those of the months its rows reach too: what it counts out of view is what it does not list.
    expect(boxes(calendar, 'sept-retro')).toHaveLength(1);
    expect(calendar.querySelector('.calendar__meta')?.textContent).toContain('1 OUT OF VIEW');
    expect(boxes(calendar, 'dentist')[0].querySelector('.note-badge')).not.toBeNull();
  });
});

describe('the meta line', () => {
  it('names the calendar where no frame does, and only says what it shows under a scene frame that names it', () => {
    expect(render(assistantWeek).querySelector('.calendar__meta')?.textContent).toBe('WEEK / OCT 5-11OCT 5 - 11 / 23 EVENTS');
    expect(render(assistantWeek, undefined, { width: 0, height: 0 }, true).querySelector('.calendar__meta')?.textContent).toBe('OCT 5 - 11 / 23 EVENTS');
  });
});

describe('an empty calendar', () => {
  it.each(['day', 'week', 'month'] as const)('says so on the %s grid it still draws', (view) => {
    const calendar = render({ view, start: '2026-10-05', today: '2026-10-07', events: [] });
    expect(calendar.querySelector('.calendar-grid__nothing')?.textContent).toBe('NOTHING SCHEDULED');
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

describe('the panel frame round a calendar', () => {
  // The frame's steps, read from its paths (TechFrame "panel"): the top
  // edge's lowest run and the bottom edge's highest, in its own units.
  function panelSteps() {
    const source = readFileSync(`${import.meta.dirname}/../../src/primitives/TechFrame.tsx`, 'utf8');
    const panel = /panel: \{\s*viewBox: '0 0 (\d+) (\d+)',\s*paths: \[([\s\S]*?)\],\s*\}/.exec(source);
    if (!panel) throw new Error('no panel frame in TechFrame.tsx');
    const height = Number(panel[2]);
    const runs: number[] = [];
    for (const [, d] of panel[3].matchAll(/d: '([^']+)'/g)) {
      let y = 0;
      for (const [, op, args] of d.matchAll(/([MLHV])([^MLHV]*)/g)) {
        const numbers = args.trim().split(/\s+/).map(Number);
        if (op === 'H') runs.push(y);
        if (op === 'V') y = numbers[0];
        if (op === 'M' || op === 'L') y = numbers[1];
      }
    }
    return {
      height,
      top: Math.max(...runs.filter((run) => run < height / 2)),
      bottom: height - Math.min(...runs.filter((run) => run > height / 2)),
    };
  }

  it('stands it in the box inside both of the frame\u2019s steps, as a share of the frame\u2019s height, in the main slot', () => {
    const steps = panelSteps();
    // One step serves both edges: the frame steps in as far at its foot as at its head.
    expect(steps.bottom).toBe(steps.top);
    expect(declared(':root', '--panel-step-share')).toEqual([`calc(${steps.top} / ${steps.height})`]);
    expect(declared(':root', '--panel-step')).toEqual(['calc(var(--panel-step-share) * 100%)']);
    expect(declared(':root', '--panel-inset')[0]).toMatch(/^calc\(var\(--panel-step\) \+ /);
    // The main slot: the step is a row of the slot's own grid (a share of
    // its height, which the layout sets), not a padding in stage units.
    const slot = '.calendar-object > .focusable-content';
    expect(declared(slot, 'grid-template-rows')).toEqual(['var(--panel-inset) minmax(0, 1fr) var(--panel-inset)']);
    expect(declared(slot, 'padding-block')).toEqual(['0']);
    expect(declared(`${slot} > *`, 'grid-row')).toEqual(['2']);
  });

  it('keeps it clear of the steps of an aux cell as tall as the aux row may grow, in an inset the row is asked for', () => {
    // The cell is sized by what it holds, so its inset is a padding (a
    // percentage track would ask the row for nothing, and the cell would
    // shrink a step at a time): the step of the tallest cell the row allows.
    const cap = /^fit-content\((\d+)%\)$/.exec(declared('.composed-main', 'grid-auto-rows')[0] ?? '')?.[1];
    expect(cap).toBeDefined();
    expect(declared('.composed-aux-object--calendar > .focusable-content', 'padding-block')).toEqual([
      `max(clamp(12px, 1.4cqw, 22px), calc(var(--panel-step-share) * ${cap}cqh + 4px))`,
    ]);
    expect(declared('.composed-aux-object--calendar > .focusable-content', 'grid-template-rows')).toEqual([]);
  });
});

describe('the time grid\u2019s fold', () => {
  it('spans the days as the hour rules do, never the gutter', () => {
    // A band out to the calendar's edge ran under the hours' scale and reached for the frame.
    expect(declared('.calendar-grid__fold', 'left')).toEqual(['var(--grid-lead, var(--calendar-gutter))']);
    expect(declared('.calendar-grid__fold', 'right')).toEqual(['var(--grid-trail, 0px)']);
    expect(declared('.calendar-grid__hour::after', 'left')).toEqual(declared('.calendar-grid__fold', 'left'));
  });
});

describe('the now and today marks', () => {
  it('marks the now on a grid with its time on a tag in the gutter and a thin rule across today only, under the events', () => {
    const calendar = render(assistantWeek);
    const now = calendar.querySelector('.calendar-grid__now') as HTMLElement;
    expect([...now.children].map((part) => part.className)).toEqual(['calendar-grid__now-text tech micro', 'calendar-grid__now-line']);
    // No line across the other days, and nothing lifting the mark over the events (each event slot has a z-index).
    expect(rulesFor('.calendar-grid__now::before')).toEqual([]);
    expect(rulesFor('.calendar-grid__now::after')).toEqual([]);
    expect(declared('.calendar-grid__now', 'z-index')).toEqual([]);
    expect(declared('.calendar-grid__now-line', 'z-index')).toEqual([]);
    expect(Number((boxes(calendar, 'standup-wed')[0] as HTMLElement).style.zIndex)).toBeGreaterThan(0);
    // A thin solid rule, no glow; the time's tag pointed at the grid.
    expect(declared('.calendar-grid__now-line', 'height')).toEqual(['1px']);
    expect(declared('.calendar-grid__now-line', 'box-shadow')).toEqual([]);
    expect(declared('.calendar-grid__now-text', 'clip-path')).toEqual(['var(--now-point)']);
  });

  it('draws the agenda\u2019s now in the same mark, and today the same way in every view', () => {
    // The agenda's NOW row: the pointed tag along the same thin rule.
    expect(declared('.calendar-agenda__now-text', 'clip-path')).toEqual(['var(--now-point)']);
    expect(declared('.calendar-agenda__now-line', 'height')).toEqual(['1px']);
    expect(declared('.calendar-agenda__now-line', 'box-shadow')).toEqual([]);
    // Today: an orange rule along the top of its column head and its month cell, never a box round it.
    expect(declared('.calendar-month__cell--today', 'box-shadow')).toEqual(['inset 0 1px 0 var(--orange)']);
    expect(declared('.calendar-grid__day--today', 'box-shadow')).toEqual(['inset 0 1px 0 var(--orange)']);
  });
});
