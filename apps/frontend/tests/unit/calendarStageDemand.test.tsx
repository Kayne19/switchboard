// @vitest-environment jsdom
// What a calendar says to the stage (useStageDemand) as it is measured and
// sent again. Its stand-in, drawn before the body is measured, says
// nothing (MeasuredStageDemand); and a week whose days turn to pages, or
// back, keeps its hours viewport, and with it what that viewport measured
// in the layout the primary shares with the rail. Before, the grid stood
// in a plain box when it did not page and in PagedDays when it did, so a
// turn to pages mounted the viewport afresh, and a week given the stage
// could not give it back (REPORT-polish row 24).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { StageNeed } from '../../src/app/stageFold';
import type { CalendarData } from '../../src/controller/types';
import { StageDemandContext } from '../../src/hooks/useStageDemand';
import { CalendarPrimitive } from '../../src/primitives/CalendarPrimitive';

const box = { width: 0, height: 0 };
const observers = new Set<() => void>();
const sizes = ['offsetWidth', 'offsetHeight'].map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const);

beforeAll(() => {
  globalThis.ResizeObserver = class {
    private readonly fire: () => void;
    constructor(callback: () => void) {
      this.fire = () => callback();
      observers.add(this.fire);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      observers.delete(this.fire);
    }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => box.width });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => box.height });
});

afterAll(() => {
  for (const [key, descriptor] of sizes) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const week = (days: number): CalendarData => ({
  view: 'week', start: '2026-10-05', days, today: '2026-10-07',
  events: [{ id: 'dentist', title: 'Dentist', start: '2026-10-07T10:00', end: '2026-10-07T11:00' }],
});

it('says nothing for its stand-in, and keeps its hours viewport when its days turn to pages and back', () => {
  const heard: Array<[string, number | null]> = [];
  const listen = (key: string, need: StageNeed | null) => heard.push([key, need?.excess ?? null]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (data: CalendarData) =>
    act(() => root.render(<StageDemandContext.Provider value={listen}><CalendarPrimitive data={data} slot="primary" /></StageDemandContext.Provider>));
  const resized = () => act(() => {
    for (const fire of [...observers]) fire();
  });
  draw(week(7));
  // Unmeasured, the week is drawn whole as a stand-in, and says nothing.
  expect(heard).toEqual([]);
  // Measured 380px wide: three days a page.
  box.width = 380;
  box.height = 600;
  resized();
  expect(host.querySelector('.calendar-pages')).not.toBeNull();
  const scroll = host.querySelector('.calendar-grid__scroll');
  const keys = new Set(heard.map(([key]) => key));
  expect(keys.size).toBe(1);
  // Sent again with two days: they fit, and the grid no longer pages.
  draw(week(2));
  resized();
  expect(host.querySelector('.calendar-pages')).toBeNull();
  expect(host.querySelector('.calendar-grid__scroll')).toBe(scroll);
  expect(new Set(heard.map(([key]) => key))).toEqual(keys);
  // Never withdrawn: the viewport was not mounted afresh.
  expect(heard.some(([, excess]) => excess === null)).toBe(false);
  act(() => root.unmount());
  host.remove();
});
