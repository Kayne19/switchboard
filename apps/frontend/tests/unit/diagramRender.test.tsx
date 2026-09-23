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
  act(() => root.render(<DiagramPrimitive data={data} />));
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

  it('sizes the active-edge glow to the drawing so straight edges keep their stroke', () => {
    render();
    // A bounding-box filter region has zero height on a horizontal edge.
    const glow = host.querySelector('#active-edge-glow');
    expect(glow?.getAttribute('filterUnits')).toBe('userSpaceOnUse');
  });
});
