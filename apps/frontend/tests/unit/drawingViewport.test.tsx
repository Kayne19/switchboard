// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DrawingViewport } from '../../src/primitives/DrawingViewport';
import { FocusableSurface } from '../../src/primitives/FocusableSurface';
import type { DrawingFit } from '../../src/primitives/drawingFit';
import { RAIL, type DrawingMap } from '../../src/primitives/drawingScroll';

let host: HTMLDivElement;
let root: Root;

// jsdom has no layout: the scroller reports a 320 x 300 box.
const box = { clientWidth: 320, clientHeight: 300 };
const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const [name, value] of Object.entries(box)) {
    saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('drawing-viewport__scroll') ? value : 0;
      },
    });
  }
});

afterAll(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const drawing = { width: 400, height: 2000 };
const scrollsDown: DrawingFit = { scale: 0.8, width: 320, height: 1600, scrollX: false, scrollY: true };
// Twenty rows, 80 units deep with 20 between: on screen, rows of 64 px with 16 px gaps.
const rows: DrawingMap = {
  parts: Array.from({ length: 20 }, (_, index) => ({ box: { x: 0, y: index * 100 + 10, width: 400, height: 80 }, label: `ROW ${index}` })),
  noun: { one: 'ROW', many: 'ROWS' },
  marks: [],
  links: [],
  sketch: { boxes: [], lines: [] },
};
const rowSpans = rows.parts.map(({ box: part }) => [part.y * 0.8, (part.y + part.height) * 0.8] as const);

function render(element: React.ReactElement) {
  if (!host) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root.render(element));
}

describe('a drawing viewport', () => {
  it('opens a scrolling drawing on its lead, at rest, and keeps the reader there through an update that leaves its shape alone', () => {
    host = undefined as unknown as HTMLDivElement;
    render(
      <DrawingViewport drawing={drawing} fit={scrollsDown} lead={{ x: 0, y: 500, width: 100, height: 100 }} map={rows} ariaLabel="d">
        <rect width="10" height="10" />
      </DrawingViewport>,
    );
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    // The lead (400 to 480 px) whole and clear of the rails, nearest the
    // middle of the view, at a rest where no row is cut under the top rail.
    const top = scroller.scrollTop;
    expect(top).toBe(304);
    expect(rowSpans.every(([start, end]) => end <= top + RAIL || start >= top + RAIL)).toBe(true);
    scroller.scrollTop = 784;
    // A node changed state: same shape, a new drawing.
    render(
      <DrawingViewport drawing={{ ...drawing }} fit={{ ...scrollsDown }} lead={{ x: 0, y: 500, width: 100, height: 100 }} map={rows} ariaLabel="d">
        <circle r="4" />
      </DrawingViewport>,
    );
    expect(scroller.scrollTop).toBe(784);
    // The lead moved (a note now names another node): the reader is taken to it.
    render(
      <DrawingViewport drawing={drawing} fit={scrollsDown} lead={{ x: 0, y: 1200, width: 100, height: 100 }} map={rows} ariaLabel="d">
        <circle r="4" />
      </DrawingViewport>,
    );
    expect(scroller.scrollTop).toBe(864);
  });

  it('takes the keys that scroll it, from stop to stop, and leaves the surface around it the rest', () => {
    host = undefined as unknown as HTMLDivElement;
    const expanded: string[] = [];
    // Keys still reach the page: the scroller marks the ones it takes
    // rather than stopping them.
    const reached: string[] = [];
    const listen = (event: KeyboardEvent) => reached.push(event.key);
    window.addEventListener('keydown', listen);
    const scrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function go(this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      render(
        <FocusableSurface onActivate={() => expanded.push('expand')} ariaLabel="Expand">
          <DrawingViewport drawing={drawing} fit={scrollsDown} map={rows} ariaLabel="d">
            <rect width="10" height="10" />
          </DrawingViewport>
        </FocusableSurface>,
      );
      const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
      expect(scroller.getAttribute('tabindex')).toBe('0');
      const stops = [...host.querySelectorAll<HTMLElement>('.drawing-viewport__stop')].map((stop) => parseFloat(stop.style.top));
      const press = (key: string, shiftKey = false) =>
        act(() => {
          scroller.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
        });
      press('ArrowDown');
      expect(scroller.scrollTop).toBe(stops[1]);
      press(' ');
      const paged = scroller.scrollTop;
      expect(stops).toContain(paged);
      expect(paged).toBeGreaterThan(stops[1]);
      expect(paged - stops[1]).toBeLessThanOrEqual(300);
      press(' ', true);
      expect(scroller.scrollTop).toBeLessThan(paged);
      press('End');
      expect(scroller.scrollTop).toBe(stops[stops.length - 1]);
      press('Home');
      expect(scroller.scrollTop).toBe(0);
      press('ArrowLeft');
      expect(scroller.scrollTop).toBe(0);
      // Space scrolled; it did not expand. Enter is not a scrolling key: it
      // still expands the object.
      expect(expanded).toEqual([]);
      press('Enter');
      expect(expanded).toEqual(['expand']);
      expect(reached).toEqual(['ArrowDown', ' ', ' ', 'End', 'Home', 'ArrowLeft', 'Enter']);
    } finally {
      window.removeEventListener('keydown', listen);
      HTMLElement.prototype.scrollTo = scrollTo;
    }
  });

  it('pins its header band only when it scrolls down, and is contained otherwise', () => {
    host = undefined as unknown as HTMLDivElement;
    render(
      <DrawingViewport drawing={drawing} fit={scrollsDown} pinned={{ height: 80, content: <text>HEADERS</text> }} map={rows} ariaLabel="d">
        <rect width="10" height="10" />
      </DrawingViewport>,
    );
    expect(host.querySelector('.drawing-viewport__pinned')?.textContent).toBe('HEADERS');
    expect(host.querySelector('.drawing-viewport__pinned')?.getAttribute('aria-hidden')).toBe('true');
    render(
      <DrawingViewport drawing={drawing} fit={{ scale: 0.2, width: 80, height: 400, scrollX: false, scrollY: false }} pinned={{ height: 80, content: <text>HEADERS</text> }} map={rows} ariaLabel="d">
        <rect width="10" height="10" />
      </DrawingViewport>,
    );
    expect(host.querySelector('.drawing-viewport__pinned')).toBeNull();
    expect(host.querySelector('.drawing-viewport__scroll')?.getAttribute('tabindex')).toBeNull();
    expect(host.querySelector('svg')?.style.width).toBe('');
  });
});
