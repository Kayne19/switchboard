// @vitest-environment jsdom
// A week whose days turn to pages, or back, keeps its hours viewport, and
// with it the reader's place there. Before, the grid stood in a plain box
// when it did not page and in PagedDays when it did, so a turn to pages
// mounted the viewport afresh (REPORT-polish row 24).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { CalendarData } from '../../src/controller/types';
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

it('keeps its hours viewport when its days turn to pages and back', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (data: CalendarData) => act(() => root.render(<CalendarPrimitive data={data} slot="primary" />));
  const resized = () => act(() => {
    for (const fire of [...observers]) fire();
  });
  draw(week(7));
  // Measured 380px wide: three days a page.
  box.width = 380;
  box.height = 600;
  resized();
  expect(host.querySelector('.calendar-pages')).not.toBeNull();
  const scroll = host.querySelector('.calendar-grid__scroll');
  expect(scroll).not.toBeNull();
  // Sent again with two days: they fit, and the grid no longer pages.
  draw(week(2));
  resized();
  expect(host.querySelector('.calendar-pages')).toBeNull();
  // The same viewport: it was not mounted afresh.
  expect(host.querySelector('.calendar-grid__scroll')).toBe(scroll);
  act(() => root.unmount());
  host.remove();
});
