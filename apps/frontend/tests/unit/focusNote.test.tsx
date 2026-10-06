// @vitest-environment jsdom
// Focus gives an object the stage and the rail goes: the notes about it come
// with it. On a diagram the node (or actor) the note names keeps its NOTE
// marker, the drawing opens on it, and the note itself stands in a panel of
// its own; a chart keeps every note about it, its points marked; a table,
// code, a document or a figure keeps the rail's note about it.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusNotes } from '../../src/components/FocusLayer';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ChartData, ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { chartScales, chartSeriesPoint } from '../../src/primitives/chartGeometry';
import { mount, stubResizeObserver, unmount, unmountAll } from './sceneHarness';

let host: HTMLDivElement;
let dispatch: (action: ControllerAction) => void;

function ControllerHandle() {
  dispatch = useController().dispatch;
  return null;
}

// jsdom has no layout: a drawing's host reports the focus layer's room at
// 1440 x 900 beside the note (999 x 791), and its scroller that less a map's
// strip, as a browser would.
const size = { width: 999, height: 791 };
const strip = (element: HTMLElement) => {
  const box = element.closest('.drawing-viewport')?.querySelector<HTMLElement>(':scope > .drawing-viewport__strip');
  return { right: parseFloat(box?.style.width ?? '') || 0, bottom: parseFloat(box?.style.height ?? '') || 0 };
};
const isHost = (element: HTMLElement) => element.classList.contains('diagram-primitive') || element.classList.contains('sequence-primitive');
const measured: Record<string, (this: HTMLElement) => number> = {
  offsetWidth() {
    return isHost(this) ? size.width + 1 : 0;
  },
  offsetHeight() {
    return isHost(this) ? size.height + 1 : 0;
  },
  clientWidth() {
    return this.classList.contains('drawing-viewport__scroll') ? size.width - strip(this).right : 0;
  },
  clientHeight() {
    return this.classList.contains('drawing-viewport__scroll') ? size.height - strip(this).bottom : 0;
  },
};
const saved: Record<string, PropertyDescriptor | undefined> = {};

stubResizeObserver();

beforeEach(() => {
  for (const [name, get] of Object.entries(measured)) {
    saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
  }
});

afterEach(() => {
  unmountAll();
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

function focusOn(actions: ControllerAction[], id: string): HTMLElement {
  host = mount(
    <ControllerProvider>
      <SceneRenderer />
      <ControllerHandle />
    </ControllerProvider>,
  );
  for (const action of actions) act(() => dispatch(action));
  act(() => dispatch({ op: 'focus', id }));
  // The first frame lays the drawing out for the screen; the measured
  // viewport arrives with the next.
  act(() => dispatch({ op: 'focus', id }));
  const layer = host.querySelector<HTMLElement>('.focus-layer');
  expect(layer).not.toBeNull();
  return layer!;
}

describe('a diagram in focus keeps its note', () => {
  it('marks the node the note names, opens on it, and shows the note beside the drawing', () => {
    const layer = focusOn(fixtures.topology, 'topology');
    // Before: focus passed no note: no marker, no note, opened at the start.
    const marked = [...layer.querySelectorAll('.diagram-nodes > g')].filter((group) => group.querySelector('.diagram-node__marker'));
    expect(marked.map((group) => group.querySelector('.diagram-node-label')?.textContent)).toEqual(['Display gate']);
    const card = layer.querySelector('.focus-layer__note .annotation-card');
    expect(card?.textContent).toContain('The gate stamps each action with a seq');
    expect(card?.querySelector('.note-badge')?.textContent).toBe('NOTE');
    expect(layer.querySelector('.focus-layer__content--noted')).not.toBeNull();
    // Opened on the node it names, whole in view.
    const scroller = layer.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    const svg = scroller.querySelector('svg')!;
    const [, , viewWidth, viewHeight] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    const scale = parseFloat(svg.style.width) / viewWidth;
    const offsetX = Math.max(0, (scroller.clientWidth - viewWidth * scale) / 2);
    const offsetY = Math.max(0, (scroller.clientHeight - viewHeight * scale) / 2);
    const gate = marked[0];
    const [x, y] = (/translate\(([-\d.]+) ([-\d.]+)\)/.exec(gate.getAttribute('transform') ?? '') ?? []).slice(1).map(Number);
    const [, width, height] = /H [\d.]+ L ([\d.]+) [\d.]+ V ([\d.]+)/.exec(gate.querySelector('.diagram-node__frame')?.getAttribute('d') ?? '')?.map(Number) ?? [];
    const left = offsetX + x * scale - scroller.scrollLeft;
    const top = offsetY + y * scale - scroller.scrollTop;
    expect(scroller.scrollLeft + scroller.scrollTop).toBeGreaterThan(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width * scale).toBeLessThanOrEqual(scroller.clientWidth);
    expect(top + height * scale).toBeLessThanOrEqual(scroller.clientHeight);
  });

  it('marks the actor a sequence\'s note names, and shows the note', () => {
    const layer = focusOn(fixtures.trace, 'trace');
    expect(layer.querySelectorAll('.sequence-actor__marker').length).toBeGreaterThan(0);
    expect(layer.querySelector('.focus-layer__note .annotation-card')?.textContent).toContain('waits for the page to confirm');
  });

  it('shows a note short enough for a callout in its panel, never on the drawing as well', () => {
    const short: ControllerAction[] = [
      fixtures.architecture[0],
      { op: 'show', id: 'short-note', type: 'note', data: { tag: 'NOTE', anchor: { target: 'system-map', node: 'session' }, segments: [{ text: 'Context moves.' }] } },
    ];
    const layer = focusOn(short, 'system-map');
    expect(layer.querySelector('.diagram-callout')).toBeNull();
    expect(layer.querySelector('.diagram-node__marker')).not.toBeNull();
    expect(layer.querySelector('.focus-layer__note')?.textContent).toContain('Context moves.');
  });

  it('shows no panel for a diagram no note names, nor a note about another object', () => {
    const state = reduceActions(createInitialState(), [
      ...fixtures.topology,
      { op: 'show', id: 'other-note', type: 'note', data: { segments: [{ text: 'about the table' }], anchor: { target: 'elsewhere' } } },
    ]);
    expect(focusNotes(state, state.objects['topology']).map((note) => note.data.segments[0].text)).toEqual([expect.stringMatching(/^A display counts/)]);
    const plain = reduceActions(createInitialState(), [fixtures.topology[0]]);
    expect(focusNotes(plain, plain.objects['topology'])).toEqual([]);
    // A focused note is the note: nothing beside it.
    expect(focusNotes(state, state.objects['topology-note'])).toEqual([]);
  });
});

// Focus kept only a diagram's note (and a list's): a chart's notes, and the
// note about a table, code, a document or a figure, went with the rail the
// moment their object took the stage (polish row 11).
describe('any object in focus keeps the notes about it', () => {
  const early: ControllerAction = {
    op: 'show', id: 'early-note', type: 'note',
    data: { tag: 'EARLY / EPOCH 6', anchor: { target: 'loss', x: 6, series: 'TRAIN LOSS' }, segments: [{ text: 'Both losses fall together through the warmup.' }] },
  };

  it('keeps every note about a chart beside it, each naming its point, and the chart marks each point', () => {
    const layer = focusOn([...fixtures.training, early], 'loss');
    const cards = [...layer.querySelectorAll('.focus-layer__note .annotation-card')];
    expect(cards.map((card) => card.querySelector('.annotation-card__anchor')?.textContent)).toEqual([
      'TARGET / EPOCH 32 / VAL LOSS',
      'TARGET / EPOCH 6 / TRAIN LOSS',
    ]);
    expect(cards[0].textContent).toContain('Validation loss turns upward here');
    expect(layer.querySelector('.focus-layer__content--noted')).not.toBeNull();
    // No leader reaches a point in focus: the marker's ring marks epoch 32,
    // which the first note names, and a hollow ring the second's.
    const data = fixtures.training[0].op === 'show' ? (fixtures.training[0].data as ChartData) : undefined;
    const scales = chartScales(data!);
    const marker = layer.querySelector('.chart-marker__point')!;
    expect(Number(marker.getAttribute('cx'))).toBeCloseTo(chartSeriesPoint(data!, 32, 'VAL LOSS', scales)!.x, 3);
    const rings = [...layer.querySelectorAll('.chart-note-ring')];
    expect(rings).toHaveLength(1);
    expect(Number(rings[0].getAttribute('cx'))).toBeCloseTo(chartSeriesPoint(data!, 6, 'TRAIN LOSS', scales)!.x, 3);
    expect(layer.querySelector('.chart-marker__value')).toBeNull();
  });

  it("keeps the note about a bar chart beside it, its bar outlined and its value printed", () => {
    const layer = focusOn(fixtures.comparison, 'durations');
    expect(layer.querySelector('.focus-layer__note .annotation-card__anchor')?.textContent).toBe('TARGET / frontend visual / THIS RUN');
    expect(layer.querySelector('.chart-callout[data-index="2"][data-series="THIS RUN"]')).not.toBeNull();
  });

  for (const [fixture, id, note] of [
    ['results', 'test-matrix', 'results-note'],
    ['code', 'source', 'code-note'],
    ['email', 'mail', 'email-note'],
    ['figure', 'test-card', 'figure-note'],
  ] as const) {
    it(`keeps the note about the ${fixture} fixture's ${id} beside it`, () => {
      // The fixture's note, anchored to its object, as the rail shows it.
      const actions = fixtures[fixture].map((action) =>
        action.op === 'show' && action.id === note ? { ...action, data: { ...(action.data as object), anchor: { target: id } } } : action,
      ) as ControllerAction[];
      const layer = focusOn(actions, id);
      const card = layer.querySelector('.focus-layer__note .annotation-card');
      expect(card?.getAttribute('data-anchor-target')).toBe(id);
      expect(layer.querySelector('.focus-layer__content--noted')).not.toBeNull();
    });
  }

  it("keeps the note about a plan's progress, and about a metric, beside it", () => {
    const plan = focusOn(fixtures.plan, 'ship-plan');
    expect(plan.querySelector('.focus-layer__note .annotation-card')?.textContent).toContain('waits on the graph layout');
    unmount(host);
    const metric: ControllerAction = { op: 'show', id: 'build-note', type: 'note', data: { anchor: { target: 'build-time' }, segments: [{ text: 'Two seconds faster since the cache moved.' }] } };
    const layer = focusOn([...fixtures.plan, metric], 'build-time');
    expect(layer.querySelector('.focus-layer__note .annotation-card')?.textContent).toContain('Two seconds faster');
    expect(layer.querySelector('.focus-layer__content--metric.focus-layer__content--noted')).not.toBeNull();
  });

  it('shows no panel for an object no note names', () => {
    const layer = focusOn(fixtures.code, 'source');
    // The code fixture's note names no object: it is about the scene.
    expect(layer.querySelector('.focus-layer__note')).toBeNull();
    expect(layer.querySelector('.focus-layer__content--noted')).toBeNull();
  });
});
