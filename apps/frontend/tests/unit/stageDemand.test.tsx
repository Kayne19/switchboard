// @vitest-environment jsdom
// What a primary's content says it asks of the stage (useStageDemand): how
// much taller than its viewport it would have to be to be read whole. The
// shell folds a rail under the primary on it (stageFold.test.tsx); here, the
// saying.
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { scrollContentHeight, StageDemandContext, useStageBoxHeight, useStageDemand } from '../../src/hooks/useStageDemand';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function Says({ excess }: { excess: number | null }) {
  useStageDemand(excess);
  return null;
}

function Measures({ onHeight }: { onHeight: (height: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  onHeight(useStageBoxHeight(ref));
  return <div ref={ref} />;
}

describe('what a primitive says it lacks', () => {
  it('reaches the listener in whole pixels, and is taken back when the primitive goes', () => {
    const heard: Array<[string, number | null]> = [];
    const host = document.createElement('div');
    const root = createRoot(host);
    const listen = (key: string, excess: number | null) => heard.push([key, excess]);
    act(() => root.render(<StageDemandContext.Provider value={listen}><Says excess={120.4} /></StageDemandContext.Provider>));
    expect(heard.at(-1)?.[1]).toBe(120);
    act(() => root.render(<StageDemandContext.Provider value={listen}><Says excess={-30.6} /></StageDemandContext.Provider>));
    expect(heard.at(-1)?.[1]).toBe(-31);
    const key = heard.at(-1)![0];
    act(() => root.render(<StageDemandContext.Provider value={listen} />));
    expect(heard.at(-1)).toEqual([key, null]);
    act(() => root.unmount());
  });

  it('goes nowhere where nothing listens, and nothing is measured there', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const heights: number[] = [];
    // No ResizeObserver in jsdom: a measure here would throw.
    act(() => root.render(<><Says excess={500} /><Measures onHeight={(height) => heights.push(height)} /></>));
    expect(heights.every((height) => height === 0)).toBe(true);
    act(() => root.unmount());
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

