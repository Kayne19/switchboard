// @vitest-environment jsdom
// What a primary's content says it asks of the stage (useStageDemand): how
// much taller than its viewport it would have to be to be read whole. The
// shell folds a rail under the primary on it (stageFold.test.tsx); here, the
// saying.
import { act, useRef } from 'react';
import type { StageNeed } from '../../src/app/stageFold';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { MeasuredStageDemand, scrollContentHeight, StageDemandContext, useLeastHeight } from '../../src/hooks/useStageDemand';
import { DrawingViewport } from '../../src/primitives/DrawingViewport';
import { SLIVER, type DrawingFit } from '../../src/primitives/drawingFit';
import type { DrawingMap } from '../../src/primitives/drawingScroll';

function Box({ least }: { least: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useLeastHeight(ref, least);
  return <div ref={ref} />;
}

describe('what a primitive says it lacks', () => {
  it('goes nowhere where nothing listens, and nothing is measured there', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    // No ResizeObserver in jsdom: a measure here would throw.
    expect(globalThis.ResizeObserver).toBeUndefined();
    act(() => root.render(<Box least={900} />));
    act(() => root.unmount());
  });

  it('says what a box lacks for the least height its content reads in, again when that changes', () => {
    const heard: Array<number | null> = [];
    const observed: Element[] = [];
    globalThis.ResizeObserver = class {
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 374 });
    try {
      const host = document.createElement('div');
      const root = createRoot(host);
      const listen = (_key: string, need: StageNeed | null) => heard.push(need?.excess ?? null);
      act(() => root.render(<StageDemandContext.Provider value={listen}><Box least={900.4} /></StageDemandContext.Provider>));
      expect(heard.at(-1)).toBe(526);
      expect(observed).toHaveLength(1);
      act(() => root.render(<StageDemandContext.Provider value={listen}><Box least={300} /></StageDemandContext.Provider>));
      expect(heard.at(-1)).toBe(-74);
      act(() => root.unmount());
      expect(heard.at(-1)).toBeNull();
    } finally {
      if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });
});

describe('a primitive that lays itself out for its box', () => {
  it('says nothing for the stand-in it draws before its box is measured, and speaks once it is', () => {
    const heard: Array<number | null> = [];
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 374 });
    try {
      const host = document.createElement('div');
      const root = createRoot(host);
      const listen = (_key: string, need: StageNeed | null) => heard.push(need?.excess ?? null);
      const draw = (measured: boolean, least: number) =>
        act(() => root.render(<StageDemandContext.Provider value={listen}><MeasuredStageDemand measured={measured}><Box least={least} /></MeasuredStageDemand></StageDemandContext.Provider>));
      // The stand-in, drawn whole for an unmeasured box, would ask for 526px.
      draw(false, 900);
      expect(heard).toEqual([]);
      // Measured, the drawing that stands is heard, and only it.
      draw(true, 400);
      expect(heard).toEqual([26]);
      act(() => root.unmount());
      expect(heard.at(-1)).toBeNull();
    } finally {
      if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });
});

describe('how tall a scroll region\'s content is', () => {
  const box = (element: Element, top: number, height: number) => {
    element.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  };
  const sized = (element: HTMLElement, sizes: Record<string, number>) => {
    for (const [key, value] of Object.entries(sizes)) Object.defineProperty(element, key, { configurable: true, value });
  };

  it('is what it scrolls through when it overflows', () => {
    const region = document.createElement('div');
    sized(region, { scrollHeight: 900, clientHeight: 300, offsetHeight: 300 });
    expect(scrollContentHeight(region)).toBe(900);
  });

  it('is the end of its last child and its padding when it has room to spare', () => {
    const region = document.createElement('div');
    region.style.paddingBottom = '20px';
    const child = document.createElement('div');
    region.append(child);
    document.body.append(region);
    sized(region, { scrollHeight: 300, clientHeight: 300, offsetHeight: 300 });
    box(region, 100, 300);
    box(child, 100, 180);
    expect(scrollContentHeight(region)).toBe(200);
    region.remove();
  });
});

describe('what a drawing asks of the stage', () => {
  const map: DrawingMap = { parts: [], noun: { one: 'NODE', many: 'NODES' }, marks: [], links: [], sketch: { boxes: [], lines: [] } };
  const drawing = { width: 400, height: 2000 };
  // Its viewport: 330 x 374 px, a phone's diagram slot.
  const sizes: Record<string, number> = { offsetWidth: 330, offsetHeight: 374, clientWidth: 330, clientHeight: 374 };

  function said(fit: DrawingFit): Array<number | null> {
    const heard: Array<number | null> = [];
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const saved = Object.keys(sizes).map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const);
    for (const [key, value] of Object.entries(sizes)) {
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('drawing-viewport') || this.classList.contains('drawing-viewport__scroll') ? value : 0;
        },
      });
    }
    try {
      const host = document.createElement('div');
      const root = createRoot(host);
      act(() => root.render(
        <StageDemandContext.Provider value={(_key, need) => heard.push(need?.excess ?? null)}>
          <DrawingViewport drawing={drawing} fit={fit} laidOutFor={() => ({ drawing, fit })} map={map} ariaLabel="d"><rect /></DrawingViewport>
        </StageDemandContext.Provider>,
      ));
      act(() => root.unmount());
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      }
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
    return heard;
  }

  it('is the height it reads whole in at its least readable scale, past its viewport', () => {
    const fit: DrawingFit = { scale: 0.8, width: 320, height: 1600, scrollX: false, scrollY: true, minScale: 0.6 };
    expect(said(fit)[0]).toBe(Math.round(2000 * 0.6 * (1 - SLIVER) - 374));
  });

  it('says nothing for a fit made for another viewport, as before its host is measured', () => {
    // Laid out for the screen: contained, and wider than the viewport it is in.
    const forTheScreen: DrawingFit = { scale: 0.5, width: 800, height: 1000, scrollX: false, scrollY: false, minScale: 0.6 };
    expect(said(forTheScreen).every((excess) => excess === null)).toBe(true);
  });
});
