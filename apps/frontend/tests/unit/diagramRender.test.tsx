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
