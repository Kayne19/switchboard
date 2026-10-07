// @vitest-environment jsdom
// review-drawing L5: a scrolled bar chart opened on `Math.round(x)` of the
// note it marks, unclamped, while the note's callout clamps x to the last
// category: a note at x 80 on 60 bars marked bar 59 and named it, but the
// chart stayed at its top, the bar out of view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const leads: Array<string | null | undefined> = [];
vi.mock('../../src/primitives/ListViewport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/primitives/ListViewport')>();
  return {
    ...actual,
    ListViewport: (props: Parameters<typeof actual.ListViewport>[0]) => {
      leads.push(props.lead);
      return actual.ListViewport(props);
    },
  };
});

import type { ChartData } from '../../src/controller/types';
import { ChartPrimitive } from '../../src/primitives/ChartPrimitive';
import { chartScrollHeight } from '../../src/primitives/chartGeometry';
import { mount, stubResizeObserver, unmountAll } from './sceneHarness';

stubResizeObserver();
// A phone's slot: 60 bars on their side do not fit it, so the chart scrolls.
const SLOT = { width: 334, height: 420 };
const data: ChartData = {
  kind: 'bar',
  labels: Array.from({ length: 60 }, (_, index) => `SERVICE-${index}`),
  series: [{ name: 'MS', values: Array.from({ length: 60 }, (_, index) => 10 + index) }],
};

let restore: Array<() => void> = [];
beforeEach(() => {
  leads.length = 0;
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
});

describe('a scrolled bar chart', () => {
  it('scrolls in this slot', () => {
    expect(chartScrollHeight(data, SLOT)).not.toBeNull();
  });

  it.each([
    [80, '59'],
    [59, '59'],
    [-5, '0'],
    [12.4, '12'],
  ])('opens on the bar a note at x %s marks', (x, bar) => {
    mount(<ChartPrimitive data={data} named={[{ x }]} />);
    expect(leads.at(-1)).toBe(bar);
    expect(document.querySelector(`.chart-grid__category[data-item="${bar}"]`)).not.toBeNull();
  });

  // review-fix-charts L6: an anchor on a series the chart does not carry has
  // no callout; the chart still opens on its clamped x, as it did.
  it('opens on the clamped x where the anchor names no series it draws', () => {
    mount(<ChartPrimitive data={data} named={[{ x: 80, series: 'NONE' }]} />);
    expect(leads.at(-1)).toBeDefined();
    expect(Number(leads.at(-1))).toBeLessThanOrEqual(59);
  });
});
