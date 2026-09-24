// @vitest-environment jsdom
// The chart note's leader (issue #26): a note that names a point is placed
// over it with a leader that leaves the card; a note anchored to the chart
// without a point is attached without one and keeps the ordinary placement.
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
// its centre on a 1000 x 500 chart drawn at scale 1, the same size whatever
// the anchor, so moving it never reports a resize. The panel's frame svg is
// larger than the chart and offset from it, as in the browser.
const originalRect = Element.prototype.getBoundingClientRect;
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains('training-note')) {
      const percent = Number.parseFloat(this.style.getPropertyValue('--annotation-anchor-x'));
      return rect((Number.isFinite(percent) ? percent * 10 : 0) - 100, 40, 200, 60);
    }
    if (this instanceof SVGSVGElement && this.closest('.chart-primitive')) return rect(0, 0, 1000, 500);
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
    const stem = host.querySelector<SVGLineElement>('.chart-pointer__stem');
    const box = host.querySelector('.training-note')!.getBoundingClientRect();

    expect(Number(stem?.getAttribute('x1'))).toBeCloseTo(box.left + box.width / 2);
    expect(Number(stem?.getAttribute('y1'))).toBeCloseTo(box.bottom);
  });

  it('starts the leader at the card after a new x moves the card without resizing it', () => {
    mount([chart, note({ target: 'loss', x: 10 })]);
    const stem = () => host.querySelector<SVGLineElement>('.chart-pointer__stem');
    const cardCentre = () => {
      const box = host.querySelector('.training-note')!.getBoundingClientRect();
      return box.left + box.width / 2;
    };

    expect(Number(stem()?.getAttribute('x1'))).toBeCloseTo(cardCentre());
    expect(Number(stem()?.getAttribute('y1'))).toBeCloseTo(100);

    const first = cardCentre();
    render(reduceActions(createInitialState(), [chart, note({ target: 'loss', x: 30 })]));

    expect(cardCentre()).not.toBeCloseTo(first);
    expect(Number(stem()?.getAttribute('x1'))).toBeCloseTo(cardCentre());
  });
});
