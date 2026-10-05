// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DrawingViewport } from '../../src/primitives/DrawingViewport';
import type { DrawingFit } from '../../src/primitives/drawingFit';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const drawing = { width: 400, height: 2000 };
const scrollsDown: DrawingFit = { scale: 0.8, width: 320, height: 1600, scrollX: false, scrollY: true };

function render(element: React.ReactElement) {
  if (!host) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root.render(element));
}

describe('a drawing viewport', () => {
  it('opens a scrolling drawing on its lead, and keeps the reader there through an update that leaves its shape alone', () => {
    host = undefined as unknown as HTMLDivElement;
    render(
      <DrawingViewport drawing={drawing} fit={scrollsDown} lead={{ x: 0, y: 500, width: 100, height: 100 }} ariaLabel="d">
        <rect width="10" height="10" />
      </DrawingViewport>,
    );
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    // jsdom has no layout: the viewport's height reads 0, so the lead's
    // centre goes to the top.
    expect(scroller.scrollTop).toBe(550 * 0.8);
    scroller.scrollTop = 900;
    // A node changed state: same shape, a new drawing.
    render(
      <DrawingViewport drawing={{ ...drawing }} fit={{ ...scrollsDown }} lead={{ x: 0, y: 500, width: 100, height: 100 }} ariaLabel="d">
        <circle r="4" />
      </DrawingViewport>,
    );
    expect(scroller.scrollTop).toBe(900);
    // The lead moved (a note now names another node): the reader is taken to it.
    render(
      <DrawingViewport drawing={drawing} fit={scrollsDown} lead={{ x: 0, y: 1200, width: 100, height: 100 }} ariaLabel="d">
        <circle r="4" />
      </DrawingViewport>,
    );
    expect(scroller.scrollTop).toBe(1250 * 0.8);
  });

  it('keeps the keys that scroll it from the surface around it', () => {
    host = undefined as unknown as HTMLDivElement;
    const reached: string[] = [];
    render(
      <div onKeyDown={(event) => reached.push(event.key)}>
        <DrawingViewport drawing={drawing} fit={scrollsDown} ariaLabel="d">
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
      <DrawingViewport drawing={drawing} fit={scrollsDown} pinned={{ height: 80, content: <text>HEADERS</text> }} ariaLabel="d">
        <rect width="10" height="10" />
      </DrawingViewport>,
    );
    expect(host.querySelector('.drawing-viewport__pinned')?.textContent).toBe('HEADERS');
    expect(host.querySelector('.drawing-viewport__pinned')?.getAttribute('aria-hidden')).toBe('true');
    render(
      <DrawingViewport drawing={drawing} fit={{ scale: 0.2, width: 80, height: 400, scrollX: false, scrollY: false }} pinned={{ height: 80, content: <text>HEADERS</text> }} ariaLabel="d">
        <rect width="10" height="10" />
      </DrawingViewport>,
    );
    expect(host.querySelector('.drawing-viewport__pinned')).toBeNull();
    expect(host.querySelector('.drawing-viewport__scroll')?.getAttribute('tabindex')).toBeNull();
    expect(host.querySelector('svg')?.style.width).toBe('');
  });
});
