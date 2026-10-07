// @vitest-environment jsdom
// A chart's first frame. `ChartNotes` called flushSync straight from a
// layout effect to find the chart's canvas, and React logged "flushSync was
// called from inside a lifecycle method" for every chart with notes. And
// `useElementSize` read the box in a passive effect, after the frame was
// painted, so a chart recomposed for its slot (`chartFrame`) painted its
// first frame at the approved 1000x500 canvas while the notes over it were
// placed for the recomposed one (pr/issues.md, "ChartNotes calls flushSync
// inside a layout effect").
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartNotes, type ChartNote } from '../../src/components/ChartNotes';
import type { ChartData, SceneObject } from '../../src/controller/types';
import { ChartPrimitive } from '../../src/primitives/ChartPrimitive';
import { chartFrame } from '../../src/primitives/chartGeometry';
import { mount, rootOf, stubResizeObserver, unmountAll } from './sceneHarness';

const data: ChartData = {
  xLabel: 'EPOCH',
  xMax: 8,
  series: [{ name: 'VAL', values: [0.31, 0.28, 0.25, 0.23, 0.22, 0.22, 0.23, 0.25, 0.27] }],
};
const chart = { id: 'loss', type: 'chart', data } as SceneObject<ChartData>;
const notes: ChartNote[] = [{ key: 'turn', data: { tag: 'OBSERVATION', anchor: { target: 'loss', x: 6 }, segments: [{ text: 'Turns upward.' }] } }];

// A slot the chart is recomposed for: a phone's, taller than wide.
const SLOT = { width: 360, height: 420 };

let restore: Array<() => void> = [];
beforeEach(() => {
  stubResizeObserver();
  for (const [key, value] of [['offsetWidth', SLOT.width], ['offsetHeight', SLOT.height]] as const) {
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)!;
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    restore.push(() => Object.defineProperty(HTMLElement.prototype, key, before));
  }
});
afterEach(() => {
  unmountAll();
  for (const undo of restore) undo();
  restore = [];
  vi.restoreAllMocks();
});

function Panel() {
  return (
    <div className="chart-object">
      <ChartPrimitive data={data} named={[{ x: 6 }]} led={[{ x: 6 }]} />
      <ChartNotes chart={chart} objects={{ loss: chart }} notes={notes} onFocus={() => {}} />
    </div>
  );
}

describe("a chart's first frame", () => {
  it('logs no flushSync warning when a chart with notes mounts', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount(<Panel />);
    const said = errors.mock.calls.map((call) => call.map(String).join(' '));
    expect(said.filter((line) => line.includes('flushSync'))).toEqual([]);
  });

  it.each([
    ['alone', () => <ChartPrimitive data={data} />],
    ['under its notes', () => <Panel />],
  ])('is drawn in the frame its slot gives it, in the commit it mounts in (%s)', async (_, node) => {
    const recomposed = chartFrame(SLOT);
    expect(`${recomposed.width}x${recomposed.height}`).not.toBe('1000x500');
    // Rendered as the page renders, not in act(): React commits, and any
    // update a layout effect makes is committed with it, in one task, before
    // the browser paints; a passive effect runs in a later task. A mutation
    // observer's callback runs between the two (a microtask), so it sees the
    // DOM as the first painted frame shows it.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const host = mount(null);
      const seen: string[] = [];
      const watcher = new MutationObserver(() => {
        const view = host.querySelector('.chart-primitive svg')?.getAttribute('viewBox');
        if (view && seen.length === 0) seen.push(view);
      });
      watcher.observe(host, { childList: true, subtree: true, attributes: true });
      rootOf(host).render(node());
      await vi.waitFor(() => expect(seen.length).toBe(1));
      watcher.disconnect();
      expect(seen[0]).toBe(`0 0 ${recomposed.width} ${recomposed.height}`);
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      act(() => {});
    }
  });
});
