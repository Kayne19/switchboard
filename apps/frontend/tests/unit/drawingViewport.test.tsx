// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DrawingViewport } from '../../src/primitives/DrawingViewport';
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
const scrollsDown: DrawingFit = { scale: 0.8, width: 320, height: 1600, scrollX: false, scrollY: true, minScale: 0.8 };
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

  it('keeps the keys that scroll it from the surface around it', () => {
    host = undefined as unknown as HTMLDivElement;
    const reached: string[] = [];
    render(
      <div onKeyDown={(event) => reached.push(event.key)}>
        <DrawingViewport drawing={drawing} fit={scrollsDown} map={rows} ariaLabel="d">
          <rect width="10" height="10" />
        </DrawingViewport>
      </div>,
    );
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    expect(scroller.getAttribute('tabindex')).toBe('0');
    for (const key of [' ', 'PageDown', 'ArrowDown', 'Enter']) {
      act(() => {
        scroller.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    }
    // Enter is not a scrolling key: it still expands the object.
    expect(reached).toEqual(['Enter']);
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
      <DrawingViewport drawing={drawing} fit={{ scale: 0.2, width: 80, height: 400, scrollX: false, scrollY: false, minScale: 0.2 }} pinned={{ height: 80, content: <text>HEADERS</text> }} map={rows} ariaLabel="d">
        <rect width="10" height="10" />
      </DrawingViewport>,
    );
    expect(host.querySelector('.drawing-viewport__pinned')).toBeNull();
    expect(host.querySelector('.drawing-viewport__scroll')?.getAttribute('tabindex')).toBeNull();
    expect(host.querySelector('svg')?.style.width).toBe('');
  });
});
