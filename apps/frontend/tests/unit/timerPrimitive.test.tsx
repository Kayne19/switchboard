// @vitest-environment jsdom
// A timer counts down against the page's one clock (usePageClock): one
// timeout for the whole page however many timers it shows, none while no
// countdown runs. Driven here by a fake clock, so the boundaries a
// countdown must get right -- exactly zero, past zero, paused, a start
// still to come -- are pinned as the page draws them.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimerData } from '../../src/controller/types';
import { TimerPrimitive } from '../../src/primitives/TimerPrimitive';

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

let roots: Root[] = [];
let hosts: HTMLElement[] = [];

function render(data: TimerData, marked?: string): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<TimerPrimitive data={data} marked={marked} />));
  roots.push(root);
  hosts.push(host);
  return host;
}

const item = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-item="${id}"]`)!;
const digits = (host: HTMLElement, id: string) => item(host, id).querySelector('.timer__digits')!.textContent;
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const host of hosts) host.remove();
  roots = [];
  hosts = [];
  vi.useRealTimers();
});

describe('the page clock', () => {
  it('is one timeout for every timer on the page, and none once they are gone', () => {
    render(kitchen);
    render(kitchen);
    expect(vi.getTimerCount()).toBe(1);
    tick(5000);
    expect(vi.getTimerCount()).toBe(1);
    for (const root of roots) act(() => root.unmount());
    roots = [];
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not run while every timer is paused', () => {
    const host = render({ timers: [kitchen.timers[1]] });
    expect(vi.getTimerCount()).toBe(0);
    tick(10_000);
    expect(digits(host, 'bread')).toBe('21:00');
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

  it('marks the timer a note names, and only it', () => {
    const host = render(kitchen, 'bread');
    expect([...host.querySelectorAll('.note-badge')].map((badge) => badge.closest('[data-item]')!.getAttribute('data-item'))).toEqual(['bread']);
    expect(item(host, 'bread').className).toContain('--marked');
  });
});
