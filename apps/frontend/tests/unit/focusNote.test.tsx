// @vitest-environment jsdom
// Focus gives a diagram the stage and the rail goes: the note about it comes
// with it. The node (or actor) the note names keeps its NOTE marker, the
// drawing opens on it, and the note itself stands in a panel of its own.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { focusNote } from '../../src/components/FocusLayer';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

let host: HTMLDivElement;
let root: Root;
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

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  for (const [name, get] of Object.entries(measured)) {
    saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
  }
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

function focusOn(actions: ControllerAction[], id: string): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <ControllerProvider>
        <SceneRenderer />
        <ControllerHandle />
      </ControllerProvider>,
    ),
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
    expect(focusNote(state, state.objects['topology'])?.segments[0].text).toMatch(/^A display counts/);
    const plain = reduceActions(createInitialState(), [fixtures.topology[0]]);
    expect(focusNote(plain, plain.objects['topology'])).toBeNull();
    // A note is about a diagram here; a focused note or chart keeps its own way.
    expect(focusNote(state, state.objects['topology-note'])).toBeNull();
  });
});
