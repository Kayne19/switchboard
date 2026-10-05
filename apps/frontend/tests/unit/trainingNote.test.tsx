// @vitest-environment jsdom
// The chart notes (#26, #49): every note on a chart lies over its panel --
// the chart is not shrunk for them -- and none is dropped. A note that names
// a point on the chart runs a leader from its card to that point, straight
// and at 45 degrees like the frames; a note that names none is attached
// without one.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SceneShell } from '../../src/components/Scenes';
import { ControllerProvider } from '../../src/controller/context';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ControllerAction, ControllerState } from '../../src/controller/types';
import { chartBarCallout, chartSeriesPoint } from '../../src/primitives/chartGeometry';

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
  CARD.height = 80;
});

function render(state: ControllerState) {
  act(() =>
    root.render(
      <ControllerProvider>
        <SceneShell kind="training" state={state} onToggleListening={() => {}} onFocus={() => {}} setTranscriptOpen={() => {}} />
      </ControllerProvider>,
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

  it('hands the rail a note the chart has no place for clear of its bars, and rings the point it names', () => {
    // Every bar stands to the top of the domain the chart gives (a domain
    // the page chooses leaves headroom), the gaps between them are
    // narrower than a card, and the card is taller than the band above the
    // plot: no place on the chart is clear of the data.
    CARD.height = 120;
    const bars = {
      kind: 'bar' as const,
      labels: ['us-east', 'us-west', 'eu-west', 'eu-north'],
      yMax: 100,
      series: [{ name: 'UPTIME', values: [100, 100, 100, 100] }],
    };
    mount([
      { op: 'show', id: 'uptime', type: 'chart', role: 'primary', data: bars },
      note('uptime-note', { target: 'uptime', x: 2, series: 'UPTIME' }, 'eu-west held a full month.'),
    ]);

    const rail = host.querySelector('.content-rail .rail-note');
    expect(rail?.textContent).toContain('eu-west held a full month.');
    // The rail card still names what it is about, in the chart's own words.
    expect(rail?.querySelector('.annotation-card')?.getAttribute('data-anchor-target')).toBe('uptime');
    expect(rail?.querySelector('.annotation-card__anchor')?.textContent).toBe('TARGET / eu-west / UPTIME');
    // On the chart its card is out of view, with no leader, and the bar it
    // names still marked as a bar.
    expect(card('uptime-note')!.element.classList.contains('chart-note--away')).toBe(true);
    expect(leader('uptime-note')).toBeNull();
    expect(host.querySelector('.chart-note-ring')).toBeNull();
    const callout = host.querySelector('.chart-object[data-chart-id="uptime"] .chart-callout');
    expect(callout?.getAttribute('data-index')).toBe('2');
    expect(callout?.getAttribute('data-series')).toBe('UPTIME');
  });

  it('rings the point a note it hands the rail names on a line chart', () => {
    CARD.height = 560;
    mount([chart, note('loss-note', { target: 'loss', x: 20 })]);
    expect(card('loss-note')!.element.classList.contains('chart-note--away')).toBe(true);
    const ring = host.querySelector('.chart-note-ring[data-note="loss-note"]');
    const point = chartSeriesPoint(chartData, 20)!;
    expect(Number(ring?.getAttribute('cx'))).toBeCloseTo(point.x, 3);
    expect(Number(ring?.getAttribute('cy'))).toBeCloseTo(SVG_TOP + point.y, 3);
  });

  it('keeps the note in the rail when a new primary chart leaves out the same note the old one did', () => {
    CARD.height = 120;
    const bars = (values: number[]) => ({ kind: 'bar' as const, labels: ['a', 'b', 'c', 'd'], yMax: 100, series: [{ name: 'UPTIME', values }] });
    const show = (id: string, values: number[]): ControllerAction => ({ op: 'show', id, type: 'chart', role: 'primary', data: bars(values) });
    mount([show('march', [100, 100, 100, 100]), note('uptime-note', { target: 'march', x: 2 }, 'Held a full month.')]);
    expect(host.querySelector('.content-rail .rail-note')?.textContent).toContain('Held a full month.');
    // The chart is replaced, and the note now names the new one.
    render(reduceActions(createInitialState(), [show('april', [100, 100, 100, 100]), note('uptime-note', { target: 'april', x: 2 }, 'Held a full month.')]));
    expect(host.querySelector('.content-rail .rail-note')?.textContent).toContain('Held a full month.');
    expect(host.querySelector('.chart-object[data-chart-id="april"] .chart-note--away[data-note="uptime-note"]')).not.toBeNull();
  });

  // The tag read "TARGET / DURATIONS / X 2 / THIS RUN": an object id and an
  // index the caller never sees.
  it('names the category a note points at on a labelled chart, not its index', () => {
    const suite: ControllerAction = {
      op: 'show', id: 'durations', type: 'chart', role: 'primary',
      data: { kind: 'bar', labels: ['backend', 'frontend unit', 'frontend visual'], series: [{ name: 'THIS RUN', values: [41.8, 3.3, 96.4] }] },
    };
    mount([suite, note('suite-note', { target: 'durations', x: 2, series: 'THIS RUN' })]);
    expect(card('suite-note')!.element.querySelector('.annotation-card__anchor')!.textContent).toBe('TARGET / frontend visual / THIS RUN');
  });

  it("draws a bar note's leader onto the bar's printed value, from above it", () => {
    const data = { kind: 'bar' as const, labels: ['backend', 'frontend unit', 'frontend visual'], series: [{ name: 'THIS RUN', values: [41.8, 3.3, 96.4] }] };
    mount([{ op: 'show', id: 'durations', type: 'chart', role: 'primary', data }, note('suite-note', { target: 'durations', x: 2, series: 'THIS RUN' })]);
    const callout = chartBarCallout(data, { x: 2, series: 'THIS RUN' })!;
    const points = leader('suite-note')!;
    const [a, b] = points.slice(-2);
    expect(Math.abs(b.x - callout.point.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(b.y - (SVG_TOP + callout.point.y))).toBeLessThanOrEqual(0.5);
    expect(b.x - a.x).toBeCloseTo(0, 6);
    expect(b.y).toBeGreaterThan(a.y);
    expect(host.querySelector('.chart-note-leader[data-note="suite-note"]')!.classList.contains('chart-note-leader--bar')).toBe(true);
  });

  it('names the anchor as sent on a chart with a numeric x', () => {
    mount([chart, note('loss-note', { target: 'loss', x: 30, series: 'VAL LOSS' })]);
    expect(card('loss-note')!.element.querySelector('.annotation-card__anchor')!.textContent).toBe('TARGET / loss / X 30 / VAL LOSS');
  });

  it('keeps a note on its chart, and the rail empty, while the chart has a clear place for it', () => {
    CARD.height = 120;
    mount([chart, note('loss-note', { target: 'loss', x: 30 })]);
    expect(card('loss-note')!.element.classList.contains('chart-note--away')).toBe(false);
    expect(host.querySelector('.content-rail .rail-note')).toBeNull();
    expect(host.querySelector('.chart-note-ring')).toBeNull();
  });

  it('puts a note about a visual that is not a chart in the rail, not on a chart', () => {
    const table: ControllerAction = {
      op: 'show',
      id: 'results',
      type: 'table',
      data: { columns: [{ label: 'SUITE' }, { label: 'SECONDS' }], rows: [['backend', 41.8]] },
    };
    mount([chart, table, note('table-note', { target: 'results' }, 'The backend suite is the long pole.')]);
    expect(host.querySelector('.chart-note[data-note="table-note"]')).toBeNull();
    expect(host.querySelector('.content-rail .rail-note')?.textContent).toContain('The backend suite is the long pole.');
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
