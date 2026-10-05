// @vitest-environment jsdom
// The notes over a chart were placed again on every frame of a resize: a
// placement costs up to tens of milliseconds (60-80 ms for a line chart of
// four series with three notes and the rail), so a resize dropped frames
// (polish row 14). They are placed once a step of the size, as a graph is
// laid out once a step; within a step the cards follow their points, and
// where the size comes to rest they are placed for it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/primitives/notePlacement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/primitives/notePlacement')>();
  return { ...actual, layoutNotes: vi.fn(actual.layoutNotes) };
});

import { ChartNotes, chartNoteAnchors, type ChartNote } from '../../src/components/ChartNotes';
import type { ChartData, SceneObject } from '../../src/controller/types';
import { ChartPrimitive } from '../../src/primitives/ChartPrimitive';
import { chartPointCallouts } from '../../src/primitives/chartGeometry';
import { layoutNotes } from '../../src/primitives/notePlacement';

const data: ChartData = {
  xLabel: 'EPOCH',
  xMax: 40,
  series: [
    { name: 'TRAIN', values: [0.3, 0.26, 0.22, 0.19, 0.17, 0.15, 0.14, 0.13, 0.12] },
    { name: 'VAL', values: [0.31, 0.28, 0.25, 0.23, 0.22, 0.22, 0.23, 0.25, 0.27] },
  ],
};
const chart: SceneObject<ChartData> = { id: 'loss', type: 'chart', data } as SceneObject<ChartData>;
const notes: ChartNote[] = [
  { key: 'turn', data: { tag: 'OBSERVATION', anchor: { target: 'loss', x: 30, series: 'VAL' }, segments: [{ text: 'Validation turns upward here.' }] } },
  { key: 'about', data: { tag: 'NOTE', segments: [{ text: 'A note about the whole run.' }] } },
];
const named = chartNoteAnchors(chart, notes);

// jsdom lays nothing out. The layer is `size.width` x 600; the chart's svg
// is as wide, half as tall, 60 px down it; every card is 300 x 80.
const size = { width: 1000 };
const originalRect = Element.prototype.getBoundingClientRect;
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
const SVG_TOP = 60;
const observers = new Set<() => void>();

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = () => callback();
    }
    observe() {
      observers.add(this.callback);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains('chart-notes')) return rect(0, 0, size.width, 600);
    if (this instanceof HTMLElement && this.classList.contains('chart-note')) return rect(0, 0, 300, 80);
    if (this instanceof SVGSVGElement && this.closest('.chart-primitive')) return rect(0, SVG_TOP, size.width, size.width / 2);
    return originalRect.call(this);
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

afterEach(() => {
  size.width = 1000;
  act(() => root.unmount());
  host.remove();
  observers.clear();
  vi.useRealTimers();
  vi.mocked(layoutNotes).mockClear();
});

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <div className="chart-object">
        <ChartPrimitive data={data} named={named} />
        <ChartNotes chart={chart} notes={notes} onFocus={() => {}} named={named} />
      </div>,
    ),
  );
}

// Every card's place, and the end of every leader, as drawn.
function drawn() {
  const cards = Object.fromEntries(
    [...host.querySelectorAll<HTMLElement>('.chart-note')].map((card) => [card.dataset.note, { left: parseFloat(card.style.left), top: parseFloat(card.style.top) }]),
  );
  const ends = Object.fromEntries(
    [...host.querySelectorAll<SVGGElement>('.chart-note-leader')].map((group) => {
      const points = group.querySelector('polyline')!.getAttribute('points')!.split(' ');
      const [x, y] = points[points.length - 1].split(',').map(Number);
      return [group.dataset.note, { x, y }];
    }),
  );
  return { cards, ends };
}

// Where the leader to the named point lands on the layer at this width.
function landing(width: number) {
  const [callout] = chartPointCallouts(data, named);
  const scale = width / 1000;
  return { x: callout.point.x * scale, y: SVG_TOP + callout.point.y * scale };
}

describe('chart notes through a resize', () => {
  it('are placed once a size step, follow their points between, and are placed where the size rests', () => {
    vi.useFakeTimers();
    mount();
    const placements = () => vi.mocked(layoutNotes).mock.calls.length;
    const atMount = placements();
    expect(atMount).toBeGreaterThan(0);
    vi.mocked(layoutNotes).mockClear();

    // A resize from 1000 to 1160 px, a frame for every pixel.
    for (let width = 1001; width <= 1160; width += 1) {
      size.width = width;
      act(() => observers.forEach((measure) => measure()));
      // The leader still lands by the named point's value, however the card got there.
      const end = drawn().ends.turn;
      const at = landing(width);
      expect(Math.abs(end.x - at.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(end.y - at.y)).toBeLessThanOrEqual(1);
    }
    // Ten steps of 16 px crossed: a placement for each (one may place twice,
    // trying narrower cards), not one for each of the 160 frames.
    expect(placements()).toBeLessThanOrEqual(2 * 10);
    vi.mocked(layoutNotes).mockClear();

    // Where it rests, the notes are placed for the size, as at a page
    // opened at that size.
    act(() => vi.advanceTimersByTime(1000));
    expect(placements()).toBeGreaterThan(0);
    expect(placements()).toBeLessThanOrEqual(atMount);
    const rested = drawn();
    act(() => root.unmount());
    host.remove();
    observers.clear();
    mount();
    expect(drawn()).toEqual(rested);
  });

  it('do nothing for a measure that finds the size unchanged', () => {
    mount();
    vi.mocked(layoutNotes).mockClear();
    act(() => observers.forEach((measure) => measure()));
    expect(vi.mocked(layoutNotes).mock.calls.length).toBe(0);
  });

  it('stand where they were placed when a resize comes back to the size they were placed for', () => {
    vi.useFakeTimers();
    mount();
    const placed = drawn();
    for (const width of [1005, 1009, 1000]) {
      size.width = width;
      act(() => observers.forEach((measure) => measure()));
    }
    expect(drawn()).toEqual(placed);
    vi.mocked(layoutNotes).mockClear();
    act(() => vi.advanceTimersByTime(1000));
    expect(vi.mocked(layoutNotes).mock.calls.length).toBe(0);
  });
});
