// @vitest-environment jsdom
// A list in the primary slot asks the stage for the height it lacks
// (useStageDemand): by its scroll content, or, for content that grows to
// fill whatever view it gets (a calendar's hour grid), by the least height
// it says it reads whole in. Without `least`, a grid that always fits its
// view would ask for the stage it was given forever.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StageNeed } from '../../src/app/stageFold';
import { StageDemandContext } from '../../src/hooks/useStageDemand';
import { ListViewport } from '../../src/primitives/ListViewport';

let height: PropertyDescriptor | undefined;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 });
});

afterEach(() => {
  if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

function heardFor(least?: number | null) {
  const heard = new Map<string, number | null>();
  const host = document.createElement('div');
  const root = createRoot(host);
  const listen = (key: string, need: StageNeed | null) => heard.set(key, need?.excess ?? null);
  act(() => root.render(
    <StageDemandContext.Provider value={listen}>
      <ListViewport noun={['HOUR', 'HOURS']} least={least}>
        <div data-item="a">a</div>
      </ListViewport>
    </StageDemandContext.Provider>,
  ));
  const said = [...heard.values()].filter((excess) => excess !== null);
  act(() => root.unmount());
  return { said, after: [...heard.values()] };
}

describe('a list asks the stage', () => {
  it('for its least height, when it gives one, and for nothing else', () => {
    // A 300px view and a grid that reads whole from 26px an hour x 24.
    const { said, after } = heardFor(624);
    expect(said).toEqual([324]);
    expect(after.every((excess) => excess === null)).toBe(true);
  });

  it('by its scroll content, when it gives none', () => {
    // A 300px view over 900px of rows.
    const sizes = ['clientHeight', 'scrollHeight'].map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const);
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 900 });
    try {
      expect(heardFor(undefined).said).toEqual([600]);
    } finally {
      for (const [key, descriptor] of sizes) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    }
  });
});
