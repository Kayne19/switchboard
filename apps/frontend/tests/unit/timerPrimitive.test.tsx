// @vitest-environment jsdom
// A timer counts down against the page's one clock (usePageClock): one
// timeout for the whole page however many timers it shows, none while no
// countdown runs. Driven here by a fake clock, so the boundaries a
// countdown must get right -- exactly zero, past zero, paused, a start
// still to come -- are pinned as the page draws them.
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimerData } from '../../src/controller/types';
import { TimerPrimitive } from '../../src/primitives/TimerPrimitive';
import { timerGridLeast } from '../../src/primitives/timerReading';
import { mount, rootOf, stubResizeObserver, unmount, unmountAll } from './sceneHarness';

const NOW = Date.parse('2026-10-07T18:33:00-07:00');
const at = (minutes: number) => new Date(NOW + minutes * 60_000 - 7 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '-07:00');

const kitchen: TimerData = {
  timers: [
    { id: 'pasta', label: 'Pasta', startedAt: at(-1.5), endsAt: at(7.5) },
    { id: 'bread', label: 'Bread', startedAt: at(-24), endsAt: at(21), state: 'paused', remaining: 1260 },
    { id: 'eggs', label: 'Eggs', endsAt: at(0.05) },
    { id: 'later', label: 'Starts later', startedAt: at(2), endsAt: at(12) },
  ],
};

// In an aux cell, where no frame names the timers and they lead with their title.
function render(data: TimerData, marked?: string): HTMLElement {
  return mount(<TimerPrimitive data={data} slot="aux" marked={marked} />);
}

const item = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-item="${id}"]`)!;
const digits = (host: HTMLElement, id: string) => item(host, id).querySelector('.timer__digits')!.textContent;
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

stubResizeObserver();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('the page clock', () => {
  it('is one timeout for every timer on the page, and none once they are gone', () => {
    const pages = [render(kitchen), render(kitchen)];
    expect(vi.getTimerCount()).toBe(1);
    tick(5000);
    expect(vi.getTimerCount()).toBe(1);
    for (const page of pages) unmount(page);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not run while every timer is paused', () => {
    const host = render({ timers: [kitchen.timers[1]] });
    expect(vi.getTimerCount()).toBe(0);
    tick(10_000);
    expect(digits(host, 'bread')).toBe('21:00');
  });

  it('a timer resumed draws the time now on its first frame, not the time it mounted', () => {
    const paused: TimerData = { timers: [{ id: 'bread', label: 'Bread', startedAt: at(-24), endsAt: at(21), state: 'paused', remaining: 1260 }] };
    const host = render(paused);
    // A minute passes with nothing running, then the agent resumes it.
    vi.setSystemTime(NOW + 60_000);
    const resumed: TimerData = { timers: [{ id: 'bread', label: 'Bread', startedAt: at(-24), endsAt: at(22) }] };
    // The commit the browser paints: layout effects run, passive ones wait.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    flushSync(() => rootOf(host).render(<TimerPrimitive data={resumed} slot="aux" />));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    expect(digits(host, 'bread')).toBe('21:00');
  });

  // The skill writes an end from the agent's clock, to the microsecond
  // (`datetime.now(...) + timedelta(minutes=9)`), so nearly every timer
  // ends a fraction past a second. Its digits change a whole number of
  // seconds before that end, at the same fraction: a clock ticking on the
  // whole second showed one too many for up to a second, and the end late.
  it('turns a countdown over on the fraction of a second its end falls on, and is done at that end', () => {
    // 18:33:03.250, written as the skill writes it; the page opens at 18:33:00.000.
    const host = render({ timers: [{ id: 'tea', label: 'Tea', endsAt: '2026-10-08T01:33:03.250000+00:00' }] });
    expect(digits(host, 'tea')).toBe('00:04');
    tick(249);
    expect(digits(host, 'tea')).toBe('00:04');
    tick(1);
    expect(digits(host, 'tea')).toBe('00:03');
    tick(2999);
    expect(digits(host, 'tea')).toBe('00:01');
    expect(item(host, 'tea').dataset.phase).toBe('running');
    tick(1);
    expect(digits(host, 'tea')).toBe('00:00');
    expect(item(host, 'tea').dataset.phase).toBe('done');
    tick(61_000);
    expect(item(host, 'tea').querySelector('.timer__meta')!.textContent).toBe('ENDED 01:33 UTC / +01:01');
  });

  it('turns each countdown on its own fraction, still on one timeout', () => {
    const host = render({ timers: [kitchen.timers[2], { id: 'tea', label: 'Tea', endsAt: '2026-10-08T01:33:03.250Z' }] });
    expect(vi.getTimerCount()).toBe(1);
    expect([digits(host, 'eggs'), digits(host, 'tea')]).toEqual(['00:03', '00:04']);
    tick(250);
    expect([digits(host, 'eggs'), digits(host, 'tea')]).toEqual(['00:03', '00:03']);
    tick(750);
    expect([digits(host, 'eggs'), digits(host, 'tea')]).toEqual(['00:02', '00:03']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a timer shown while another runs reads the time now, not the last tick', () => {
    render(kitchen);
    // 600 ms on, the kitchen's clock has not ticked since the page opened.
    vi.setSystemTime(NOW + 600);
    const host = render({ timers: [{ id: 'tea', label: 'Tea', endsAt: '2026-10-08T01:33:03.250Z' }] });
    // 2650 ms to go.
    expect(digits(host, 'tea')).toBe('00:03');
  });

  // A view of timers joins or leaves the page in a task of its own (a new
  // display's commit, focus opening, an exit animation ending). A browser
  // may run that task after a turn is due but before the clock's timeout:
  // the turn must still reach every view, not be cancelled for the next.
  it('a view that leaves in the task before a turn does not hold the others back', () => {
    const eggs = render({ timers: [kitchen.timers[2]] });
    const tea = render({ timers: [{ id: 'tea', label: 'Tea', endsAt: '2026-10-08T01:33:09.250Z' }] });
    // Due at the eggs' end, and queued before the clock's own timeout for it.
    setTimeout(() => unmount(tea), 3000);
    tick(3000);
    expect(item(eggs, 'eggs').dataset.phase).toBe('done');
  });

  it('a view that joins in the task before a turn does not hold the others back', () => {
    // Committed in the task itself, as the page commits a new display (in
    // act() a render would wait for the end of the whole tick).
    const tea = document.createElement('div');
    document.body.append(tea);
    const root = createRoot(tea);
    // Queued before the clock's timeout for the eggs' turn at one second.
    setTimeout(() => flushSync(() => root.render(<TimerPrimitive data={{ timers: [{ id: 'tea', label: 'Tea', endsAt: '2026-10-08T01:33:09.250Z' }] }} slot="aux" />)), 1000);
    const eggs = render({ timers: [kitchen.timers[2]] });
    tick(1000);
    expect(digits(tea, 'tea')).toBe('00:09');
    expect(digits(eggs, 'eggs')).toBe('00:02');
    act(() => root.unmount());
    tea.remove();
  });

  it('turns every countdown over on the same whole second', () => {
    vi.setSystemTime(NOW + 400);
    const host = render(kitchen);
    expect(digits(host, 'pasta')).toBe('07:30');
    tick(599);
    expect(digits(host, 'pasta')).toBe('07:30');
    tick(1);
    expect(digits(host, 'pasta')).toBe('07:29');
    expect(digits(host, 'later')).toBe('11:59');
  });
});

describe('a timer', () => {
  it('counts down, reads 00:00 and done at exactly zero, and counts the time since', () => {
    const host = render(kitchen);
    expect(digits(host, 'eggs')).toBe('00:03');
    expect(item(host, 'eggs').dataset.phase).toBe('running');
    tick(2000);
    expect(digits(host, 'eggs')).toBe('00:01');
    tick(1000);
    expect(digits(host, 'eggs')).toBe('00:00');
    expect(item(host, 'eggs').dataset.phase).toBe('done');
    expect(item(host, 'eggs').querySelector('.timer__phase')!.textContent).toBe('DONE');
    tick(65_000);
    expect(digits(host, 'eggs')).toBe('00:00');
    expect(item(host, 'eggs').querySelector('.timer__meta')!.textContent).toBe('ENDED 18:33 / +01:05');
  });

  it('a timer done before the page opened is done at once', () => {
    vi.setSystemTime(NOW + 3_600_000);
    const host = render(kitchen);
    expect(item(host, 'pasta').dataset.phase).toBe('done');
    expect(item(host, 'pasta').querySelector<HTMLElement>('.timer__fill')!.style.width).toBe('100%');
  });

  it('a paused timer is frozen at its remaining and marked paused', () => {
    const host = render(kitchen);
    expect(digits(host, 'bread')).toBe('21:00');
    tick(30_000);
    expect(digits(host, 'bread')).toBe('21:00');
    expect(item(host, 'bread').dataset.phase).toBe('paused');
    expect(item(host, 'bread').querySelector('.timer__phase')!.textContent).toBe('PAUSED');
    expect(item(host, 'bread').querySelector('.timer__meta')!.textContent).toBe('53% OF 45:00');
  });

  it('shows the share gone when it has a start, and none before that start', () => {
    const host = render(kitchen);
    const fill = (id: string) => item(host, id).querySelector<HTMLElement>('.timer__fill')?.style.width;
    expect(fill('pasta')).toBe('16.667%');
    expect(fill('later')).toBe('0%');
    expect(item(host, 'eggs').querySelector('.timer__track')).toBeNull();
    tick(54_000);
    expect(fill('pasta')).toBe('26.667%');
  });

  it('says when it ends, as written', () => {
    const host = render(kitchen);
    expect(item(host, 'pasta').querySelector('.timer__meta')!.textContent).toBe('ENDS 18:40 / 17% OF 09:00');
    expect(item(host, 'eggs').querySelector('.timer__meta')!.textContent).toBe('ENDS 18:33');
  });

  it('shows its title where no frame does, and only there', () => {
    const titled: TimerData = { ...kitchen, title: 'KITCHEN / TIMERS' };
    const loose = render(titled);
    expect(loose.querySelector('[data-object-title]')?.textContent).toBe('KITCHEN / TIMERS');
    // With no title of its own it still names what it is.
    expect(render(kitchen).querySelector('[data-object-title]')?.textContent).toBe('TIMERS');
    const host = mount(<TimerPrimitive data={titled} slot="primary" />);
    expect(host.querySelector('[data-object-title]')).toBeNull();
  });

  it('marks the timer a note names, and only it', () => {
    const host = render(kitchen, 'bread');
    expect([...host.querySelectorAll('.note-badge')].map((badge) => badge.closest('[data-item]')!.getAttribute('data-item'))).toEqual(['bread']);
    expect(item(host, 'bread').className).toContain('--marked');
  });
});

// What the field asks of a box that takes its height from it (an aux cell,
// whose row is as tall as its cells ask). It asked what it drew, and a grid
// laid out for its box draws a little less than its box: beside a source at
// 820x1180 the row went 282.8 -> 356.2 -> 310.1 px and round again, cells,
// rows, cells, every frame. jsdom lays nothing out, so the field's box and
// the rows' height are given here; tests/visual/composition.spec.ts watches
// the row in a browser.
describe('the height the timers ask', () => {
  let field = { width: 0, height: 0 };
  let rows = 0;
  const observers = new Map<Element, ResizeObserverCallback>();
  const saved = (['offsetWidth', 'offsetHeight'] as const).map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const);
  const stub = globalThis.ResizeObserver;
  const report = () => act(() => {
    for (const [element, callback] of observers) {
      const height = element.classList.contains('timer-list__rows') ? rows : field.height;
      callback([{ target: element, borderBoxSize: [{ blockSize: height, inlineSize: field.width }], contentRect: { height, width: field.width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
  const ask = (host: HTMLElement) => host.querySelector<HTMLElement>('.timer-primitive__field')!.style.getPropertyValue('--timer-ask');

  beforeEach(() => {
    observers.clear();
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observers.set(element, this.callback);
      }
      unobserve() {}
      disconnect() {
        for (const [element, callback] of observers) if (callback === this.callback) observers.delete(element);
      }
    } as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => field.width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => field.height });
  });

  afterEach(() => {
    unmountAll();
    globalThis.ResizeObserver = stub;
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  });

  it('is the same whatever height the box gave them, cells or rows', () => {
    // Four timers, MM:SS: at 730 px a grid of readable cells needs less than their rows.
    const least = timerGridLeast(730, 4, 5)!;
    field = { width: 730, height: 236 };
    rows = 327;
    const host = render(kitchen);
    report();
    expect(ask(host)).toBe(`${least}px`);
    const seen = new Set<string>();
    for (const height of [236, 309.4, 263.3, least, least - 2, 150]) {
      field = { width: 730, height };
      report();
      seen.add(host.querySelector('[data-testid="timer"]')!.getAttribute('data-layout')!);
      expect(ask(host), `given ${height}`).toBe(`${least}px`);
    }
    // The box chose what was drawn: cells in some heights, rows in others.
    expect(seen).toEqual(new Set(['grid-2x2', 'list']));
  });

  it('is the rows\' height where a grid of readable cells would need more', () => {
    field = { width: 730, height: 120 };
    rows = 64.0625;
    const host = render({ timers: [kitchen.timers[0]] });
    report();
    expect(timerGridLeast(730, 1, 5)).toBeGreaterThan(rows);
    expect(ask(host)).toBe('64.0625px');
    field = { width: 730, height: 400 };
    report();
    expect(ask(host)).toBe('64.0625px');
  });

  it('is the rows\' height where no grid reads at the width', () => {
    // A day to go is eleven characters, too wide for readable digits in 200 px.
    field = { width: 200, height: 600 };
    rows = 130;
    const host = render({ timers: [{ id: 'trip', label: 'Trip', endsAt: at(26 * 60) }, kitchen.timers[0]] });
    report();
    expect(timerGridLeast(200, 2, 11)).toBeNull();
    expect(ask(host)).toBe('130px');
  });

  it('measures rows that name no item, so a note or a count finds each timer once', () => {
    const host = render(kitchen, 'bread');
    expect(host.querySelectorAll('[data-item]')).toHaveLength(kitchen.timers.length);
    expect(host.querySelector('.timer-primitive__measure')!.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelectorAll('.timer-primitive__measure .timer-row')).toHaveLength(kitchen.timers.length);
  });
});
