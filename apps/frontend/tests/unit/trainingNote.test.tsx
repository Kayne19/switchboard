// @vitest-environment jsdom
// The chart notes (#26, #49): every note on a chart lies over its panel --
// the chart is not shrunk for them -- and none is dropped. A note that names
// a point on the chart runs a leader from its card to that point, straight
// and at 45 degrees like the frames; a note that names none is attached
// without one.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TrainingScene } from '../../src/components/Scenes';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ControllerAction, ControllerState } from '../../src/controller/types';
import { chartSeriesPoint } from '../../src/primitives/chartGeometry';

const chart: ControllerAction = {
  op: 'show',
  id: 'loss',
  type: 'chart',
  role: 'primary',
  data: {
    xMax: 40,
    series: [{ name: 'VAL LOSS', values: [0.3, 0.25, 0.2, 0.18, 0.2] }],
  },
};
const chartData = (chart as { data: Parameters<typeof chartSeriesPoint>[0] }).data;

function note(id: string, anchor?: { target: string; x?: number; series?: string }, text = 'Validation turns upward here.'): ControllerAction {
  return {
    op: 'show',
    id,
    type: 'note',
    data: { tag: 'OBSERVATION', ...(anchor ? { anchor } : {}), segments: [{ text }] },
  };
}

// jsdom does no layout. The note layer is 1000 x 600; the chart's svg is
// drawn 1000 x 500 from 60 px down the layer, at scale 1 unless `svgWidth`
// letterboxes it; every card is 300 x 80 wherever it is put.
const originalRect = Element.prototype.getBoundingClientRect;
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}
const SVG_TOP = 60;
const CARD = { width: 300, height: 80 };

let host: HTMLDivElement;
let root: Root;
let svgWidth = 1000;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains('chart-notes')) return rect(0, 0, 1000, 600);
    if (this instanceof HTMLElement && this.classList.contains('chart-note')) return rect(0, 0, CARD.width, CARD.height);
    if (this instanceof SVGSVGElement && this.closest('.chart-primitive')) return rect(0, SVG_TOP, svgWidth, 500);
    if (this instanceof SVGSVGElement && this.closest('.chart-object')) return rect(-40, -60, 1080, 700);
    return originalRect.call(this);
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  svgWidth = 1000;
});

function render(state: ControllerState) {
  act(() =>
    root.render(
      <TrainingScene state={state} onToggleListening={() => {}} onFocus={() => {}} setTranscriptOpen={() => {}} />,
    ),
  );
}

function mount(actions: ControllerAction[]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  render(reduceActions(createInitialState(), actions));
}

function card(id: string) {
  const element = host.querySelector<HTMLElement>(`.chart-note[data-note="${id}"]`);
  if (!element) return null;
  const left = Number.parseFloat(element.style.left);
  const top = Number.parseFloat(element.style.top);
  return { element, left, top, right: left + CARD.width, bottom: top + CARD.height };
}

function leader(id: string) {
  const polyline = host.querySelector<SVGPolylineElement>(`.chart-note-leader[data-note="${id}"] polyline`);
  if (!polyline) return null;
  return polyline.getAttribute('points')!.split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { x, y };
  });
}

describe('chart notes', () => {
  it('shows a second note on a chart instead of swallowing it (#49)', () => {
    mount([chart, note('note1', { target: 'loss', x: 20 }, 'First, at the point.'), note('note2', undefined, 'Second, about the chart.')]);

    const panel = host.querySelector('.chart-object[data-chart-id="loss"]')!;
    expect(panel.querySelectorAll('.chart-note')).toHaveLength(2);
    expect(panel.textContent).toContain('First, at the point.');
    expect(panel.textContent).toContain('Second, about the chart.');
    // In place on the chart, not in the rail.
    expect(host.querySelector('.content-rail .rail-note')).toBeNull();

    const first = card('note1')!;
    const second = card('note2')!;
    const apart =
      first.right <= second.left || second.right <= first.left || first.bottom <= second.top || second.bottom <= first.top;
    expect(apart, 'the two cards must not cover each other').toBe(true);
  });

  it('lays the notes over the panel instead of shrinking the chart for them', () => {
    mount([chart, note('loss-note', { target: 'loss', x: 10 })]);
    const panel = host.querySelector('.chart-object[data-chart-id="loss"]')!;
    expect(panel.querySelector(':scope > .chart-notes')).not.toBeNull();
    expect(panel.classList.contains('chart-object--noted')).toBe(false);
  });

  it('runs a leader from the card\'s border to the point on the line', () => {
    mount([chart, note('loss-note', { target: 'loss', x: 30, series: 'VAL LOSS' })]);
    const box = card('loss-note')!;
    const points = leader('loss-note')!;
    const point = chartSeriesPoint(chartData, 30, 'VAL LOSS')!;

    // It grows out of the card's one-pixel bottom border...
    expect(points[0].y).toBeCloseTo(box.bottom - 0.5, 0);
    expect(points[0].x).toBeGreaterThanOrEqual(box.left);
    expect(points[0].x).toBeLessThanOrEqual(box.right);
    // ...and ends on the drawn point, on the half pixel.
    const end = points[points.length - 1];
    expect(Math.abs(end.x - point.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(end.y - (SVG_TOP + point.y))).toBeLessThanOrEqual(0.5);
    // Every run is straight or at 45 degrees, and at least one is at 45.
    const runs = points.slice(1).map((p, index) => ({ dx: p.x - points[index].x, dy: p.y - points[index].y }));
    for (const { dx, dy } of runs) {
      expect(dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) <= 1).toBe(true);
    }
    expect(runs.some(({ dx, dy }) => dx !== 0 && dy !== 0)).toBe(true);
  });

  it('fades the leader in the colour of the card\'s border', () => {
    mount([chart, note('loss-note', { target: 'loss', x: 30 })]);
    const stops = [...host.querySelectorAll('.chart-note-leader stop')];
    expect(stops.map((stop) => stop.getAttribute('class'))).toEqual([
      'chart-note-leader__stop chart-note-leader__stop--card',
      'chart-note-leader__stop chart-note-leader__stop--mid',
      'chart-note-leader__stop chart-note-leader__stop--point',
    ]);
    // The colour comes from the stylesheet's shared edge token, not inline.
    for (const stop of stops) expect(stop.getAttribute('stop-color')).toBeNull();
  });

  it('never covers the point it names', () => {
    // The point at x = 0 is the top of the plot: the card moves off it.
    mount([chart, note('loss-note', { target: 'loss', x: 0 })]);
    const box = card('loss-note')!;
    const point = chartSeriesPoint(chartData, 0)!;
    const y = SVG_TOP + point.y;
    const covered = point.x > box.left && point.x < box.right && y > box.top && y < box.bottom;
    expect(covered).toBe(false);
    expect(leader('loss-note')).not.toBeNull();
  });

  it('attaches a note with no x to the chart without a leader', () => {
    mount([chart, note('loss-note', { target: 'loss', series: 'VAL LOSS' })]);
    const box = card('loss-note')!;
    expect(box.element.classList.contains('chart-note--anchored')).toBe(false);
    expect(leader('loss-note')).toBeNull();
    // The anchor still reads in the card's header.
    expect(box.element.querySelector('.annotation-card')?.getAttribute('data-anchor-target')).toBe('loss');
  });

  it('never places a note at a NaN position on a chart with no x domain', () => {
    mount([{ ...chart, data: { ...chartData, xMax: 0 } } as ControllerAction, note('loss-note', { target: 'loss', x: 10 })]);
    const box = card('loss-note')!;
    expect(box.element.classList.contains('chart-note--anchored')).toBe(false);
    expect(box.element.getAttribute('style') ?? '').not.toContain('NaN');
    expect(leader('loss-note')).toBeNull();
  });

  it('reaches the point where the chart is drawn, not where it would be at full width', () => {
    // A panel twice the chart's aspect: the chart is drawn 1000 wide in the
    // middle of a 2000-wide svg box, 500 in from its left.
    svgWidth = 2000;
    mount([chart, note('loss-note', { target: 'loss', x: 20 })]);
    const point = chartSeriesPoint(chartData, 20)!;
    const end = leader('loss-note')!.at(-1)!;
    expect(Math.abs(end.x - (500 + point.x))).toBeLessThanOrEqual(0.5);
  });

  it('moves the leader with the card when a new x moves the card', () => {
    mount([chart, note('loss-note', { target: 'loss', x: 5 })]);
    const firstLeft = card('loss-note')!.left;
    render(reduceActions(createInitialState(), [chart, note('loss-note', { target: 'loss', x: 35 })]));
    const box = card('loss-note')!;
    expect(box.left).not.toBe(firstLeft);
    const start = leader('loss-note')![0];
    expect(start.x).toBeGreaterThanOrEqual(box.left);
    expect(start.x).toBeLessThanOrEqual(box.right);
  });

  it('puts a note that names a compare chart in that chart\'s panel, with its leader', () => {
    const compare: ControllerAction = {
      op: 'show',
      id: 'previous',
      type: 'chart',
      role: 'compare',
      data: { xMax: 40, series: [{ name: 'VAL LOSS', values: [0.32, 0.28, 0.24, 0.22, 0.21] }] },
    };
    mount([chart, compare, note('loss-note', { target: 'previous', x: 20, series: 'VAL LOSS' })]);

    const panel = host.querySelector('.chart-object[data-chart-id="previous"]')!;
    expect(panel.querySelector('.chart-note[data-note="loss-note"]')).not.toBeNull();
    expect(panel.querySelector('.chart-note-leader[data-note="loss-note"]')).not.toBeNull();
    expect(host.querySelector('.chart-object[data-chart-id="loss"] .chart-notes')).toBeNull();
  });

  it('puts a note aimed at nothing on the chart on the primary', () => {
    mount([chart, note('rail-note', { target: 'gpu' })]);
    expect(host.querySelector('.chart-object[data-chart-id="loss"] .chart-note[data-note="rail-note"]')).not.toBeNull();
    expect(leader('rail-note')).toBeNull();
  });

  it('lets a spoken explanation stand in on the primary while no note is shown', () => {
    mount([chart, { op: 'say', text: 'The spike is contained.' }]);
    const spoken = card('speech-note');
    expect(spoken).not.toBeNull();
    expect(spoken!.element.textContent).toContain('The spike is contained.');

    // A note object takes over; the spoken card resolves out (it may still
    // be fading here), so the layer carries the note alone.
    render(reduceActions(createInitialState(), [chart, { op: 'say', text: 'The spike is contained.' }, note('loss-note')]));
    expect(host.querySelector('.chart-notes')?.getAttribute('data-note-count')).toBe('1');
    expect(card('loss-note')).not.toBeNull();
  });
});
