// @vitest-environment jsdom
// The chart note (issue #26): the note sits in a band at the top of the panel
// of the chart it names, above the plot; a note that names a point centres
// over it with a leader that leaves the card and ends on the point, and a
// note anchored to the chart without a point is attached without one.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TrainingScene } from '../../src/components/Scenes';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ControllerAction, ControllerState } from '../../src/controller/types';

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

function note(anchor: { target: string; x?: number; series?: string }): ControllerAction {
  return {
    op: 'show',
    id: 'loss-note',
    type: 'note',
    data: { tag: 'OBSERVATION', anchor, segments: [{ text: 'Validation turns upward here.' }] },
  };
}

// jsdom does no layout. The card is laid out where its anchor variable puts
// its centre -- a measured pixel position, or before that a fraction of a
// 1000-wide panel -- the same size whatever the anchor, so moving it never
// reports a resize. The chart is drawn at scale 1 (`svgWidth` wider than
// 1000 letterboxes it), and the panel's frame svg is larger than the chart
// and offset from it, as in the browser.
const originalRect = Element.prototype.getBoundingClientRect;
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

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
    if (this instanceof HTMLElement && this.classList.contains('training-note')) {
      const anchor = this.style.getPropertyValue('--annotation-anchor-x');
      const value = Number.parseFloat(anchor);
      const centre = !Number.isFinite(value) ? 0 : anchor.endsWith('%') ? value * 10 : value;
      return rect(centre - 100, 40, 200, 60);
    }
    if (this instanceof SVGSVGElement && this.closest('.chart-primitive')) return rect(0, 0, svgWidth, 500);
    if (this instanceof SVGSVGElement && this.closest('.chart-object')) return rect(-40, -60, 1080, 670);
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

// The leader's wedge: the midpoints of its two ends.
function leader() {
  const polygon = host.querySelector<SVGPolygonElement>('.chart-pointer__leader');
  if (!polygon) return null;
  const [a, b, c, d] = polygon.getAttribute('points')!.split(' ').map((pair) => pair.split(',').map(Number));
  return {
    start: { x: (a[0] + d[0]) / 2, y: (a[1] + d[1]) / 2 },
    end: { x: (b[0] + c[0]) / 2, y: (b[1] + c[1]) / 2 },
  };
}

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

describe('training note anchor', () => {
  it('attaches a note with no x to the chart without a leader or a point placement', () => {
    mount([chart, note({ target: 'loss', series: 'VAL LOSS' })]);

    const card = host.querySelector<HTMLElement>('.training-note');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('training-note--anchored')).toBe(false);
    expect(card?.style.getPropertyValue('--annotation-anchor-x')).toBe('');
    expect(host.querySelector('.chart-pointer')).toBeNull();
    // The anchor still reads in the card's header.
    expect(host.querySelector('.annotation-card')?.getAttribute('data-anchor-target')).toBe('loss');
  });

  it('never places a note at a NaN position on a chart with no x domain', () => {
    mount([{ ...chart, data: { ...(chart as { data: object }).data, xMax: 0 } } as ControllerAction, note({ target: 'loss', x: 10 })]);

    const card = host.querySelector<HTMLElement>('.training-note');
    expect(card?.classList.contains('training-note--anchored')).toBe(false);
    expect(card?.getAttribute('style') ?? '').not.toContain('NaN');
    expect(host.querySelector('.chart-pointer')).toBeNull();
  });

  it('measures the card against the chart svg, not the panel frame drawn before it', () => {
    mount([chart, note({ target: 'loss', x: 10 })]);
    const box = host.querySelector('.training-note')!.getBoundingClientRect();

    expect(leader()!.start.x).toBeCloseTo(box.left + box.width / 2, 1);
    expect(leader()!.start.y).toBeCloseTo(box.bottom, 1);
    // The card spans the point, so the leader drops straight down to it.
    expect(leader()!.end.x).toBeCloseTo(leader()!.start.x, 1);
  });

  it('starts the leader at the card after a new x moves the card without resizing it', () => {
    mount([chart, note({ target: 'loss', x: 10 })]);
    const cardCentre = () => {
      const box = host.querySelector('.training-note')!.getBoundingClientRect();
      return box.left + box.width / 2;
    };

    expect(leader()!.start.x).toBeCloseTo(cardCentre(), 1);
    expect(leader()!.start.y).toBeCloseTo(100, 1);

    const first = cardCentre();
    render(reduceActions(createInitialState(), [chart, note({ target: 'loss', x: 30 })]));

    expect(cardCentre()).not.toBeCloseTo(first);
    expect(leader()!.start.x).toBeCloseTo(cardCentre(), 1);
  });

  it('centres the card over the point where the chart is drawn, not where it would be at full width', () => {
    // A panel twice the chart's aspect: the chart is drawn 1000 wide in the
    // middle of a 2000-wide svg box, 500 in from its left.
    svgWidth = 2000;
    mount([chart, note({ target: 'loss', x: 20 })]);
    const pointX = 74 + (20 / 40) * (1000 - 74 - 28);

    const card = host.querySelector<HTMLElement>('.training-note')!;
    expect(card.style.getPropertyValue('--annotation-anchor-x')).toBe(`${500 + pointX}px`);
    expect(leader()!.end.x).toBeCloseTo(pointX, 1);
    expect(leader()!.start.x).toBeCloseTo(pointX, 1);
  });

  it('sits in a band of its own at the top of the chart panel, never over the plot', () => {
    mount([chart, note({ target: 'loss', x: 10 })]);
    const panel = host.querySelector('.chart-object[data-chart-id="loss"]')!;
    const card = host.querySelector('.training-note')!;

    expect(card.parentElement).toBe(panel);
    expect(panel.classList.contains('chart-object--noted')).toBe(true);
    // The band comes before the chart surface in the panel's column.
    const surface = panel.querySelector(':scope > .focusable-content')!;
    expect(card.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts a note that names a compare chart in that chart\'s panel, with its leader', () => {
    const compare: ControllerAction = {
      op: 'show',
      id: 'previous',
      type: 'chart',
      role: 'compare',
      data: { xMax: 40, series: [{ name: 'VAL LOSS', values: [0.32, 0.28, 0.24, 0.22, 0.21] }] },
    };
    mount([chart, compare, note({ target: 'previous', x: 20, series: 'VAL LOSS' })]);

    const panel = host.querySelector('.chart-object[data-chart-id="previous"]')!;
    expect(panel.querySelector(':scope > .training-note')).not.toBeNull();
    expect(panel.querySelector('.chart-pointer__leader')).not.toBeNull();
    expect(host.querySelector('.chart-object[data-chart-id="loss"] .training-note')).toBeNull();
    expect(host.querySelector('.chart-object[data-chart-id="loss"] .chart-pointer')).toBeNull();
    // The leader leaves the card rather than the plot top.
    expect(leader()!.start.y).toBeCloseTo(100, 1);
  });
});
