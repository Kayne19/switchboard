// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SequenceDiagramData } from '../../src/controller/types';
import { DiagramObject } from '../../src/components/DiagramObject';
import { SequencePrimitive } from '../../src/primitives/SequencePrimitive';

const data: SequenceDiagramData = {
  mode: 'sequence',
  actors: [
    { id: 'caller', label: 'CALLER' },
    { id: 'pbx', label: 'PBX', sub: 'ROUTING', semantic: 'cyan' },
    { id: 'agent', label: 'AGENT' },
  ],
  messages: [
    { from: 'caller', to: 'pbx', label: 'route' },
    { from: 'pbx', to: 'agent', label: 'launch', kind: 'async' },
    { from: 'agent', to: 'agent', label: 'load' },
    { from: 'agent', to: 'pbx', label: 'ready', kind: 'return' },
    { from: 'pbx', to: 'caller', label: 'transferred', active: true },
  ],
};

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(element));
}

describe('sequence rendering', () => {
  it('draws one header and one lifeline per actor, and one arrow per message, in order', () => {
    render(<SequencePrimitive data={data} id="seq" />);
    const headers = [...host.querySelectorAll('.sequence-actors > g')];
    expect(headers.map((g) => g.querySelector('.sequence-actor-label')?.textContent)).toEqual(['CALLER', 'PBX', 'AGENT']);
    expect(headers[1].querySelector('.sequence-actor-sub')?.textContent).toBe('ROUTING');
    expect(headers[1].querySelector('.sequence-actor__frame')?.getAttribute('stroke')).toBe('var(--cyan)');
    expect(host.querySelectorAll('.sequence-lifeline')).toHaveLength(3);
    const messages = [...host.querySelectorAll('.sequence-messages > g')];
    expect(messages).toHaveLength(5);
    expect(messages.every((g) => g.querySelector('.sequence-arrowhead'))).toBe(true);
    const labels = [...host.querySelectorAll('.sequence-message-label')].map((t) => t.textContent);
    expect(labels).toEqual(['route', 'launch', 'load', 'ready', 'transferred']);
  });

  it('tells the kinds apart: a return is dashed, an async head is open, a call is solid and filled', () => {
    render(<SequencePrimitive data={data} id="seq" />);
    const lines = [...host.querySelectorAll<SVGPathElement>('.sequence-message__line')];
    expect(lines[0].hasAttribute('stroke-dasharray')).toBe(false);
    expect(lines[1].hasAttribute('stroke-dasharray')).toBe(false);
    expect(lines[3].getAttribute('stroke-dasharray')).toBe('7 5');
    const heads = [...host.querySelectorAll<SVGPathElement>('.sequence-arrowhead')];
    expect(heads[0].classList.contains('sequence-arrowhead--open')).toBe(false);
    expect(heads[0].getAttribute('fill')).not.toBe('none');
    expect(heads[1].classList.contains('sequence-arrowhead--open')).toBe(true);
    expect(heads[1].getAttribute('fill')).toBe('none');
  });

  it('glows the active message like the active graph edge, with the filter sized to the drawing', () => {
    render(<SequencePrimitive data={data} id="seq" />);
    const active = host.querySelectorAll('.sequence-message--active');
    expect(active).toHaveLength(1);
    expect(active[0].querySelector('.sequence-message__line')?.getAttribute('filter')).toBe('url(#sequence-active-glow)');
    expect(host.querySelector('#sequence-active-glow')?.getAttribute('filterUnits')).toBe('userSpaceOnUse');
  });

  it('paints message labels after the messages, each on its own backing', () => {
    render(<SequencePrimitive data={data} id="seq" />);
    const groups = [...host.querySelectorAll('svg > g')].map((group) => group.getAttribute('class'));
    expect(groups).toEqual(['sequence-lifelines', 'sequence-actors', 'sequence-messages', 'sequence-message-labels']);
    const label = host.querySelector('.sequence-message-labels > g');
    expect(label?.firstElementChild?.getAttribute('class')).toBe('sequence-message-label__backing');
  });

  it('marks the actor an anchored note names, and only when the note targets this diagram', () => {
    render(<SequencePrimitive data={data} id="seq" note={{ segments: [{ text: 'x' }], anchor: { target: 'seq', node: 'pbx' } }} />);
    const anchored = host.querySelector('.sequence-actor__body--anchored');
    expect(anchored?.querySelector('.sequence-actor-label')?.textContent).toBe('PBX');
    act(() => root.unmount());
    host.remove();
    render(<SequencePrimitive data={data} id="seq" note={{ segments: [{ text: 'x' }], anchor: { target: 'other', node: 'pbx' } }} />);
    expect(host.querySelector('.sequence-actor__body--anchored')).toBeNull();
  });

  it('gives an anchored actor its glow on every side of the frame', () => {
    render(<SequencePrimitive data={data} id="seq" note={{ segments: [{ text: 'x' }], anchor: { target: 'seq', node: 'pbx' } }} />);
    const frame = host.querySelector('.sequence-actor__body--anchored .sequence-actor__frame');
    const filterId = /^url\(#(.+)\)$/.exec(frame?.getAttribute('filter') ?? '')?.[1];
    const filter = host.querySelector(`filter[id="${filterId}"]`);
    expect(filter).not.toBeNull();
    // The frame is drawn inside its header's translated group. A region in
    // user space from (0, 0) would begin at the frame's own corner and cut
    // the glow, and half the stroke, off its top and left edges; the region
    // has to be the frame's box with room around it.
    expect(filter?.getAttribute('filterUnits') ?? 'objectBoundingBox').toBe('objectBoundingBox');
    expect(parseFloat(filter?.getAttribute('x') ?? '0')).toBeLessThan(0);
    expect(parseFloat(filter?.getAttribute('y') ?? '0')).toBeLessThan(0);
    expect(parseFloat(filter?.getAttribute('width') ?? '100')).toBeGreaterThan(100);
    expect(parseFloat(filter?.getAttribute('height') ?? '100')).toBeGreaterThan(100);
  });
});

describe('DiagramObject', () => {
  it('draws a sequence with the sequence primitive and a graph with the graph primitive', () => {
    render(<DiagramObject data={data} id="seq" />);
    expect(host.querySelector('[data-testid="sequence"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="diagram"]')).toBeNull();
    act(() => root.unmount());
    host.remove();
    render(<DiagramObject data={{ mode: 'graph', nodes: [{ id: 'a', label: 'A' }], edges: [] }} id="graph" />);
    expect(host.querySelector('[data-testid="diagram"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sequence"]')).toBeNull();
  });
});
