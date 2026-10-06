// @vitest-environment jsdom
// The notes over a chart were placed again on every frame of a resize: a
// placement costs up to tens of milliseconds (hundreds for a dense bar
// chart of four series with five notes and the rail), so a resize dropped frames
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
import { chartFrame, chartScales, chartSeriesPoint } from '../../src/primitives/chartGeometry';
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
// is as wide, half as tall (or `size.tall` times as tall), 60 px down it;
// every card is `card.width` x `card.height`. The chart's host reports no
// size, so the chart keeps the approved canvas, unless `size.slot` has it
// report the svg's: a slot the chart is recomposed for.
const size = { width: 1000, tall: 0.5, slot: false };
const card = { width: 300, height: 80 };
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
    // The layer's frame, the box the cards are placed in.
    if (this instanceof HTMLElement && this.classList.contains('chart-notes__frame')) return rect(0, 0, size.width, 600);
    if (this instanceof HTMLElement && this.classList.contains('chart-note')) return rect(0, 0, card.width, card.height);
    if (this instanceof SVGSVGElement && this.closest('.chart-primitive')) return rect(0, SVG_TOP, size.width, size.width * size.tall);
    return originalRect.call(this);
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

// The chart's host, measured through its offset size (useElementSize, chartFrame).
const offsets = {
  offsetWidth(this: HTMLElement) {
    return size.slot && this.classList.contains('chart-primitive') ? size.width : 0;
  },
  offsetHeight(this: HTMLElement) {
    return size.slot && this.classList.contains('chart-primitive') ? Math.round(size.width * size.tall) : 0;
  },
};
const savedOffsets: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  for (const [name, get] of Object.entries(offsets)) {
    savedOffsets[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
  }
});
afterAll(() => {
  for (const [name, descriptor] of Object.entries(savedOffsets)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

afterEach(() => {
  Object.assign(size, { width: 1000, tall: 0.5, slot: false });
  Object.assign(card, { width: 300, height: 80 });
  act(() => root.unmount());
  host.remove();
  observers.clear();
  vi.useRealTimers();
  vi.mocked(layoutNotes).mockClear();
});

function view(shown: ChartNote[] = notes) {
  return (
    <div className="chart-object">
      <ChartPrimitive data={data} named={named} />
      <ChartNotes chart={chart} objects={{ [chart.id]: chart }} notes={shown} onFocus={() => {}} named={named} />
    </div>
  );
}

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(view()));
}

const placements = () => vi.mocked(layoutNotes).mock.calls.length;
const resize = (width: number) => {
  size.width = width;
  act(() => observers.forEach((measure) => measure()));
};

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

// Where the leader to the named point lands on the layer at this width: the
// chart's frame letterboxed into its svg, as the chart draws it.
function landing(width: number) {
  const slot = { width, height: width * size.tall };
  const fit = size.slot ? chartFrame({ width: slot.width, height: Math.round(slot.height) }) : { ...chartFrame({ width: 0, height: 0 }) };
  const point = chartSeriesPoint(data, 30, 'VAL', chartScales(data, fit))!;
  const scale = Math.min(slot.width / fit.width, slot.height / fit.height);
  const left = (slot.width - fit.width * scale) / 2;
  const top = SVG_TOP + (slot.height - fit.height * scale) / 2;
  return { x: left + point.x * scale, y: top + point.y * scale };
}

describe('chart notes through a resize', () => {
  it('are placed once a size step, follow their points between, and are placed where the size rests', () => {
    vi.useFakeTimers();
    mount();
    const atMount = placements();
    expect(atMount).toBeGreaterThan(0);
    vi.mocked(layoutNotes).mockClear();

    // A resize from 1000 to 1160 px, a frame for every pixel.
    for (let width = 1001; width <= 1160; width += 1) {
      resize(width);
      // The leader still lands on the named point, however the card got there.
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
    for (const width of [1005, 1009, 1000]) resize(width);
    expect(drawn()).toEqual(placed);
    vi.mocked(layoutNotes).mockClear();
    act(() => vi.advanceTimersByTime(1000));
    expect(vi.mocked(layoutNotes).mock.calls.length).toBe(0);
  });

  it('follow their points through a slot the chart is recomposed for, a frame of its own shape every pixel', () => {
    // A phone's slot, taller than wide: the chart's frame takes the slot's
    // shape, so its units change with every pixel.
    Object.assign(size, { width: 380, tall: 1.3, slot: true });
    Object.assign(card, { width: 220, height: 90 });
    vi.useFakeTimers();
    mount();
    vi.mocked(layoutNotes).mockClear();
    // The steps the layer's and the svg's sizes cross: a placement for each.
    const stepOf = (width: number) => `${Math.floor(width / 16)} ${Math.floor((width * size.tall) / 16)}`;
    let steps = 0;
    for (let width = 381; width <= 420; width += 1) {
      if (stepOf(width) !== stepOf(width - 1)) steps += 1;
      resize(width);
      const end = drawn().ends.turn;
      const at = landing(width);
      // Followed through a stretched frame between steps: near the point, not on it.
      expect(Math.abs(end.x - at.x)).toBeLessThanOrEqual(3);
      expect(Math.abs(end.y - at.y)).toBeLessThanOrEqual(3);
    }
    // 40 frames, 7 steps crossed; one placement may place twice, trying narrower cards.
    expect(steps).toBeLessThan(10);
    expect(placements()).toBeLessThanOrEqual(2 * steps);
    act(() => vi.advanceTimersByTime(1000));
    const end = drawn().ends.turn;
    const at = landing(420);
    expect(Math.abs(end.x - at.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(end.y - at.y)).toBeLessThanOrEqual(0.5);
  });

  it('are placed again at once where a card changes size by itself', () => {
    mount();
    vi.mocked(layoutNotes).mockClear();
    // Its words reflowed: the card is taller, the layer and the chart as they were.
    card.height = 120;
    act(() => observers.forEach((measure) => measure()));
    expect(placements()).toBeGreaterThan(0);
  });

  it('follow a note shown again in a new object with the same words, as the spoken stand-in is every render', () => {
    vi.useFakeTimers();
    mount();
    vi.mocked(layoutNotes).mockClear();
    for (let width = 1001; width <= 1007; width += 1) {
      act(() => root.render(view(notes.map((note) => ({ ...note, data: { ...note.data } })))));
      resize(width);
    }
    expect(placements()).toBe(0);
  });
});
