import { describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { layoutDiagram, type Box, type DiagramOrientation, type Point } from '../../src/primitives/diagramLayout';

const graph = (nodes: string[], edges: Array<[string, string, string]>): DiagramData => ({
  mode: 'graph',
  nodes: nodes.map((id) => ({ id, label: id.toUpperCase() })),
  edges: edges.map(([from, to, label]) => ({ from, to, label })),
});

const graphs: Record<string, DiagramData> = {
  // The reported case: five layers, a label on every edge.
  chain: graph(['source', 'build', 'review', 'deploy', 'live'], [
    ['source', 'build', 'compile'],
    ['build', 'review', 'validate'],
    ['review', 'deploy', 'approve'],
    ['deploy', 'live', 'release'],
  ]),
  // An edge that skips a layer must not run through the node it skips.
  skip: graph(['a', 'b', 'c', 'd'], [
    ['a', 'b', 'next'],
    ['b', 'c', 'next'],
    ['a', 'c', 'shortcut'],
    ['c', 'd', 'done'],
  ]),
  fan: graph(['in', 'left', 'mid', 'right', 'out'], [
    ['in', 'left', 'west'],
    ['in', 'mid', 'centre'],
    ['in', 'right', 'east'],
    ['left', 'out', 'merge'],
    ['mid', 'out', 'merge'],
    ['right', 'out', 'merge'],
  ]),
  // A feedback loop collapses into one layer; its edges run around it.
  cycle: graph(['plan', 'act', 'check'], [
    ['plan', 'act', 'do'],
    ['act', 'check', 'verify'],
    ['check', 'plan', 'revise'],
  ]),
};

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inset = (box: Box, by: number): Box => ({
  x: box.x + by,
  y: box.y + by,
  width: box.width - 2 * by,
  height: box.height - 2 * by,
});

// Every route is axis-aligned, so a segment is a zero-thickness box.
const segmentBox = (a: Point, b: Point): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(Math.abs(a.x - b.x), 0.001),
  height: Math.max(Math.abs(a.y - b.y), 0.001),
});

for (const orientation of ['landscape', 'portrait'] as DiagramOrientation[]) {
  describe(`diagram layout / ${orientation}`, () => {
    for (const [name, data] of Object.entries(graphs)) {
      const layout = layoutDiagram(data, orientation);
      const labels = layout.edges.flatMap((edge) => (edge.label ? [edge.label] : []));

      it(`${name}: every label clears every node and every other label`, () => {
        expect(labels).toHaveLength(data.edges.length);
        for (const label of labels) {
          for (const node of layout.nodes) {
            expect(overlaps(label.box, node.box), `${label.text} over ${node.node.id}`).toBe(false);
          }
          expect(label.box.x).toBeGreaterThanOrEqual(0);
          expect(label.box.y).toBeGreaterThanOrEqual(0);
          expect(label.box.x + label.box.width).toBeLessThanOrEqual(layout.width);
          expect(label.box.y + label.box.height).toBeLessThanOrEqual(layout.height);
        }
        labels.forEach((label, index) => {
          for (const other of labels.slice(index + 1)) {
            expect(overlaps(label.box, other.box), `${label.text} over ${other.text}`).toBe(false);
          }
        });
      });

      it(`${name}: routes pass through no node but their own ends`, () => {
        for (const edge of layout.edges) {
          for (let index = 1; index < edge.points.length; index += 1) {
            const segment = segmentBox(edge.points[index - 1], edge.points[index]);
            for (const node of layout.nodes) {
              const own = node.node.id === edge.edge.from || node.node.id === edge.edge.to;
              // A route may touch its own ends' outlines, never cross their bodies.
              const body = own ? inset(node.box, 1) : node.box;
              expect(overlaps(segment, body), `${edge.edge.from}->${edge.edge.to} through ${node.node.id}`).toBe(false);
            }
          }
        }
      });
    }

    it('keeps the approved geometry when the labels already fit', () => {
      const small = layoutDiagram(graph(['a', 'b'], [['a', 'b', 'go']]), orientation);
      expect([small.width, small.height]).toEqual(orientation === 'landscape' ? [1000, 620] : [700, 1000]);
    });
  });
}


describe('diagram callout placement', () => {
  it('places a callout near the anchored node without covering other nodes in landscape', () => {
    const layout = layoutDiagram(graphs.chain, 'landscape', 'review');
    expect(layout.callout).not.toBeNull();
    expect(layout.callout?.targetNodeId).toBe('review');
    expect(layout.callout?.leader).toHaveLength(2);
    for (const node of layout.nodes) {
      if (node.node.id === 'review') continue;
      const overlapsOther = !(
        layout.callout!.box.x + layout.callout!.box.width <= node.box.x ||
        node.box.x + node.box.width <= layout.callout!.box.x ||
        layout.callout!.box.y + layout.callout!.box.height <= node.box.y ||
        node.box.y + node.box.height <= layout.callout!.box.y
      );
      expect(overlapsOther).toBe(false);
    }
  });

  it('returns null callout in portrait to trigger fallback to the rail', () => {
    const layout = layoutDiagram(graphs.chain, 'portrait', 'review');
    expect(layout.callout).toBeNull();
  });

  it('returns null callout when the node id is unknown', () => {
    const layout = layoutDiagram(graphs.chain, 'landscape', 'unknown-node');
    expect(layout.callout).toBeNull();
  });
});
