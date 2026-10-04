import { describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { layoutDiagram, type Box, type DiagramOrientation, type Point } from '../../src/primitives/diagramLayout';

// A small deterministic generator, so a failing seed can be replayed.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomGraph(seed: number, size = { nodes: 40, edges: 80 }): DiagramData {
  const next = random(seed);
  const nodeCount = size.nodes === 100 ? 100 : 2 + Math.floor(next() * size.nodes);
  const edgeCount = size.edges === 200 ? 200 : Math.floor(next() * Math.min(size.edges, nodeCount * 3));
  const states = ['done', 'active', 'todo', 'blocked', undefined] as const;
  const words = ['gateway', 'planner', 'pool', 'auth', 'relay', 'index', 'cache', 'worker', 'router', 'sidecar'];
  const phrase = (count: number) => Array.from({ length: count }, () => words[Math.floor(next() * words.length)]).join(' ');
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `n${index}`,
    label: phrase(1 + Math.floor(next() * 4)),
    sub: next() < 0.6 ? phrase(1 + Math.floor(next() * 5)) : undefined,
    detail: next() < 0.3 ? phrase(1 + Math.floor(next() * 6)) : undefined,
    state: states[Math.floor(next() * states.length)],
  }));
  const seen = new Set<string>();
  const edges: DiagramData['edges'] = [];
  while (edges.length < edgeCount) {
    const from = Math.floor(next() * nodeCount);
    const to = Math.floor(next() * nodeCount);
    if (from === to || seen.has(`${from}-${to}`)) {
      if (seen.size >= nodeCount * (nodeCount - 1)) break;
      continue;
    }
    seen.add(`${from}-${to}`);
    edges.push({ from: `n${from}`, to: `n${to}`, label: next() < 0.5 ? phrase(1 + Math.floor(next() * 3)) : undefined });
  }
  return { mode: 'graph', nodes, edges };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inset = (box: Box, by: number): Box => ({ x: box.x + by, y: box.y + by, width: box.width - 2 * by, height: box.height - 2 * by });
const segmentBox = (a: Point, b: Point): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(Math.abs(a.x - b.x), 0.001),
  height: Math.max(Math.abs(a.y - b.y), 0.001),
});
const within = (box: Box, width: number, height: number) => box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;

describe('diagram layout stays quick at the largest allowed graph', () => {
  it('lays out 100 nodes and 200 edges within a frame budget', () => {
    for (const orientation of ['landscape', 'portrait'] as DiagramOrientation[]) {
      const data = randomGraph(7, { nodes: 100, edges: 200 });
      expect(data.nodes).toHaveLength(100);
      expect(data.edges).toHaveLength(200);
      const started = performance.now();
      const layout = layoutDiagram(data, orientation);
      expect(performance.now() - started).toBeLessThan(400);
      expect(layout.nodes).toHaveLength(100);
    }
  });
});

describe('diagram layout holds its invariants on random graphs', () => {
  for (const orientation of ['landscape', 'portrait'] as DiagramOrientation[]) {
    it(`${orientation}: sixty seeds`, () => {
      for (let seed = 1; seed <= 60; seed += 1) {
        const data = randomGraph(seed);
        const started = performance.now();
        const layout = layoutDiagram(data, orientation);
        expect(performance.now() - started, `seed ${seed} time`).toBeLessThan(250);
        expect(layout.nodes, `seed ${seed}`).toHaveLength(data.nodes.length);
        expect(layout.edges, `seed ${seed}`).toHaveLength(data.edges.length);
        for (const node of layout.nodes) expect(within(node.box, layout.width, layout.height), `seed ${seed} ${node.node.id} in bounds`).toBe(true);
        layout.nodes.forEach((node, index) => {
          for (const other of layout.nodes.slice(index + 1)) {
            expect(overlaps(node.box, other.box), `seed ${seed}: ${node.node.id} over ${other.node.id}`).toBe(false);
          }
        });
        const labels = layout.edges.flatMap((edge) => (edge.label ? [edge.label] : []));
        for (const label of labels) {
          expect(within(label.box, layout.width, layout.height), `seed ${seed} label ${label.text} in bounds`).toBe(true);
          for (const node of layout.nodes) expect(overlaps(label.box, node.box), `seed ${seed}: ${label.text} over ${node.node.id}`).toBe(false);
        }
        labels.forEach((label, index) => {
          for (const other of labels.slice(index + 1)) {
            expect(overlaps(label.box, other.box), `seed ${seed}: ${label.text} over ${other.text}`).toBe(false);
          }
        });
        for (const edge of layout.edges) {
          for (let index = 1; index < edge.points.length; index += 1) {
            const segment = segmentBox(edge.points[index - 1], edge.points[index]);
            expect(Math.min(segment.width, segment.height), `seed ${seed} axis-aligned`).toBeLessThanOrEqual(0.001);
            for (const node of layout.nodes) {
              const own = node.node.id === edge.edge.from || node.node.id === edge.edge.to;
              const body = own ? inset(node.box, 1) : node.box;
              expect(overlaps(segment, body), `seed ${seed}: ${edge.edge.from}->${edge.edge.to} through ${node.node.id}`).toBe(false);
            }
          }
        }
      }
    });
  }
});
