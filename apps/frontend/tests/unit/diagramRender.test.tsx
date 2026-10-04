// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { DiagramPrimitive } from '../../src/primitives/DiagramPrimitive';

const data: DiagramData = {
  mode: 'graph',
  nodes: [
    { id: 'input', label: 'INPUT' },
    { id: 'route', label: 'ROUTE' },
    { id: 'output', label: 'OUTPUT' },
  ],
  edges: [
    { from: 'input', to: 'route', label: 'call' },
    { from: 'route', to: 'output', active: true },
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

function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<DiagramPrimitive data={data} id="test-diagram" />));
}

describe('diagram rendering', () => {
  it('positions every node by its SVG transform, with no inline transform overriding it', () => {
    render();
    const nodes = [...host.querySelectorAll<SVGGElement>('.diagram-nodes > g')];
    expect(nodes).toHaveLength(3);
    const positions = nodes.map((node) => node.getAttribute('transform'));
    expect(new Set(positions).size).toBe(3);
    for (const node of nodes) {
      // A CSS transform on an SVG element replaces its transform attribute, which
      // is how every node once collapsed onto the same corner.
      expect(node.style.transform).toBe('');
      expect(node.style.opacity).toBe('');
    }
  });

  it('draws edges with their own dash pattern rather than a normalized path length', () => {
    render();
    const edges = [...host.querySelectorAll<SVGPathElement>('.diagram-edges path')];
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.hasAttribute('pathLength')).toBe(false);
      expect(edge.style.strokeDasharray).toBe('');
      expect(edge.style.opacity).toBe('');
    }
    expect(edges[1].getAttribute('stroke-dasharray')).toBe('10 8');
    expect(edges[0].hasAttribute('stroke-dasharray')).toBe(false);
  });

  it('paints edge labels after nodes, each on its own backing', () => {
    render();
    const groups = [...host.querySelectorAll('svg > g')].map((group) => group.getAttribute('class'));
    expect(groups).toEqual(['diagram-edges', 'diagram-nodes', 'diagram-edge-labels']);
    const labels = [...host.querySelectorAll('.diagram-edge-labels > g')];
    expect(labels).toHaveLength(1);
    expect(labels[0].firstElementChild?.getAttribute('class')).toBe('diagram-edge-label__backing');
    expect(labels[0].lastElementChild?.textContent).toBe('call');
  });

  it('sizes the active-edge glow to the drawing so straight edges keep their stroke', () => {
    render();
    // A bounding-box filter region has zero height on a horizontal edge.
    const glow = host.querySelector('#active-edge-glow');
    expect(glow?.getAttribute('filterUnits')).toBe('userSpaceOnUse');
  });

  it('ends every edge in an arrowhead of its own colour, not a dot', () => {
    render();
    const edges = [...host.querySelectorAll<SVGPathElement>('.diagram-edges path')];
    for (const edge of edges) expect(edge.getAttribute('marker-end')).toBe('url(#diagram-arrow-paper)');
    expect(host.querySelector('.diagram-edges circle')).toBeNull();
    const markers = [...host.querySelectorAll('defs marker')].map((marker) => marker.id);
    expect(markers).toContain('diagram-arrow-paper');
    expect(markers).toContain('diagram-arrow-red');
    // The arrowhead scales with the drawing, as the frames do.
    expect(host.querySelector('#diagram-arrow-paper')?.getAttribute('markerUnits')).toBe('userSpaceOnUse');
  });

  it('sizes each node box to its text and wraps a long label', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const sized: DiagramData = {
      mode: 'graph',
      nodes: [
        { id: 'short', label: 'PBX' },
        { id: 'long', label: 'Speech-to-text sidecar for the call', sub: 'whisper', detail: 'apps/backend/src/stt.rs' },
      ],
      edges: [{ from: 'short', to: 'long' }],
    };
    act(() => root.render(<DiagramPrimitive data={sized} id="test-diagram" />));
    const [short, long] = [...host.querySelectorAll<SVGGElement>('.diagram-nodes > g')];
    const widthOf = (node: SVGGElement) => Number(node.querySelector('.diagram-node__frame')?.getAttribute('d')?.match(/H ([\d.]+) L/)?.[1]);
    expect(widthOf(long)).toBeGreaterThan(widthOf(short));
    expect(long.querySelectorAll('.diagram-node-label')).toHaveLength(2);
    expect(long.querySelector('.diagram-node-sub')?.textContent).toBe('whisper');
    expect(long.querySelector('.diagram-node-detail')?.textContent).toBe('apps/backend/src/stt.rs');
    expect(short.querySelector('.diagram-node-sub')).toBeNull();
  });
});

describe('diagram node state', () => {
  const stateful: DiagramData = {
    mode: 'graph',
    nodes: [
      { id: 'done', label: 'FETCH', state: 'done' },
      { id: 'active', label: 'BUILD', state: 'active' },
      { id: 'todo', label: 'SHIP', state: 'todo' },
      { id: 'blocked', label: 'AUDIT', state: 'blocked' },
    ],
    edges: [
      { from: 'done', to: 'active' },
      { from: 'active', to: 'todo' },
      { from: 'active', to: 'blocked' },
    ],
  };
  // Nodes render in data order.
  const nodeOf = (id: string) => [...host.querySelectorAll<SVGGElement>('.diagram-nodes > g')][stateful.nodes.findIndex((node) => node.id === id)];

  it('shows each state on its node: done dimmed with a check, active lit, blocked framed red with a cross', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<DiagramPrimitive data={stateful} id="test-diagram" />));
    const done = nodeOf('done');
    expect(done.querySelector('.diagram-node__body--done')).not.toBeNull();
    expect(done.querySelector('.diagram-node__tag--done polyline')).not.toBeNull();

    const active = nodeOf('active');
    expect(active.querySelector('.diagram-node__body--active')).not.toBeNull();
    expect(active.querySelector('.diagram-node__frame')?.getAttribute('filter')).toBe('url(#active-edge-glow)');
    expect(active.querySelector('.diagram-node__tag')).toBeNull();

    const blocked = nodeOf('blocked');
    expect(blocked.querySelector('.diagram-node__body--blocked')).not.toBeNull();
    expect(blocked.querySelector('.diagram-node__frame')?.getAttribute('stroke')).toBe('var(--red)');
    expect(blocked.querySelector('.diagram-node__tag--blocked path')).not.toBeNull();

    const todo = nodeOf('todo');
    expect(todo.querySelector('.diagram-node__body--todo')).not.toBeNull();
    expect(todo.querySelector('.diagram-node__frame')?.getAttribute('filter')).toBeNull();
    expect(todo.querySelector('.diagram-node__tag')).toBeNull();
  });
});


describe('anchored diagram note', () => {
  it('highlights the node and renders a callout with leader line', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <DiagramPrimitive
          data={data}
          id="test-diagram"
          note={{
            tag: 'OBSERVATION',
            anchor: { target: 'test-diagram', node: 'route' },
            segments: [{ text: 'Route description.' }],
          }}
        />,
      ),
    );

    const callout = host.querySelector('.diagram-callout');
    expect(callout).not.toBeNull();
    const leader = host.querySelector('.diagram-callout__leader');
    expect(leader).not.toBeNull();
    const anchoredNode = host.querySelector('.diagram-node__body--anchored');
    expect(anchoredNode).not.toBeNull();
    expect(anchoredNode?.querySelector('.diagram-node-label')?.textContent).toBe('ROUTE');
  });

  it('preserves default rendering when the anchored node is unknown', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <DiagramPrimitive
          data={data}
          id="test-diagram"
          note={{
            tag: 'OBSERVATION',
            anchor: { target: 'test-diagram', node: 'nonexistent' },
            segments: [{ text: 'Route description.' }],
          }}
        />,
      ),
    );

    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__body--anchored')).toBeNull();
  });
});


describe('anchored note fit and ownership', () => {
  function renderAnchored(note: { tag?: string; anchor?: { target: string; node?: string; x?: number; series?: string }; segments: Array<{ text: string }> }) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<DiagramPrimitive data={data} id="test-diagram" note={note} />));
  }

  it('falls back to the rail badge without truncating when the note does not fit the callout', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [
        {
          text: 'The voice does not change. Context moves. Damocles routes the session into the project directory, then the project orchestrator delegates work without exposing those internal handoffs to you.',
        },
      ],
    });

    // Six wrapped lines will not fit the three-line callout box, so the
    // note is not truncated: it stays in the rail and the node carries the
    // matching badge instead.
    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__body--anchored')).not.toBeNull();
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
  });

  it('renders the full text in the callout when it fits', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [{ text: 'Context moves. Damocles routes the session into the project directory.' }],
    });

    const callout = host.querySelector('.diagram-callout');
    expect(callout).not.toBeNull();
    // A wrapped line is one tspan; assert on a phrase that stays within a
    // single wrapped line so line boundaries cannot break the match.
    expect(callout?.textContent).toContain('Damocles routes');
    expect(callout?.textContent).toContain('directory');
  });

  it('keeps a note in the rail when its tag is too wide for the callout box', () => {
    renderAnchored({
      tag: 'CURRENT EXPLANATION / ROUTING / PROJECT SESSION / HEADLESS PI',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [{ text: 'Context moves here.' }],
    });

    // The tag is one unwrapped line: drawn in the 240-unit box it would run
    // across the diagram, so the note falls back to the rail instead.
    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
  });

  it('keeps a note in the rail when one word is wider than a callout line', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [{ text: 'Config lives at /etc/switchboard/projects/registry.d/override.json now.' }],
    });

    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
  });

  it('hands a placed callout back to the rail when the diagram unmounts', () => {
    const placed: boolean[] = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <DiagramPrimitive
          data={data}
          id="test-diagram"
          note={{ tag: 'OBSERVATION', anchor: { target: 'test-diagram', node: 'route' }, segments: [{ text: 'Context moves here.' }] }}
          onCalloutChange={(value) => placed.push(value)}
        />,
      ),
    );
    expect(host.querySelector('.diagram-callout')).not.toBeNull();
    expect(placed.at(-1)).toBe(true);

    // A surface boundary replacing a diagram that threw unmounts it the same
    // way; the scene must not keep hiding the note from the rail.
    act(() => root.render(<div />));
    expect(placed.at(-1)).toBe(false);
  });

  it('does not capture a note whose target is another object', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'other-object', node: 'route' },
      segments: [{ text: 'Route description.' }],
    });

    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__body--anchored')).toBeNull();
    expect(host.querySelector('.diagram-node__marker')).toBeNull();
  });
});
