import { describe, expect, it } from 'vitest';
import { createLayers } from '../../src/primitives/diagramLayout';
import type { DiagramEdge, DiagramNode } from '../../src/controller/types';

function layerIds(nodes: DiagramNode[], edges: DiagramEdge[]) {
  const started = performance.now();
  const layers = createLayers(nodes, edges);
  expect(performance.now() - started).toBeLessThan(10);
  return layers.map((layer) => layer.map((node) => node.id));
}

describe('diagram layering', () => {
  it('terminates for self-loops and lays a pure cycle out as a chain', () => {
    expect(
      layerIds([{ id: 'a', label: 'A' }], [{ from: 'a', to: 'a' }]),
    ).toEqual([['a']]);

    // The back edge b->a is reversed for layering; a leads because it comes first.
    expect(
      layerIds(
        [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      ),
    ).toEqual([['a'], ['b']]);
  });

  it('places a rooted feedback loop after its external root, one layer per node', () => {
    const nodes = ['root', 'a', 'b', 'c'].map((id) => ({ id, label: id }));
    const edges = [
      { from: 'root', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ];

    expect(layerIds(nodes, edges)).toEqual([['root'], ['a'], ['b'], ['c']]);
  });

  it('layers disconnected acyclic and cyclic components together', () => {
    const nodes = ['source', 'sink', 'cycle-a', 'cycle-b', 'isolated'].map((id) => ({
      id,
      label: id,
    }));
    const edges = [
      { from: 'source', to: 'sink' },
      { from: 'cycle-a', to: 'cycle-b' },
      { from: 'cycle-b', to: 'cycle-a' },
    ];

    expect(layerIds(nodes, edges)).toEqual([
      ['source', 'cycle-a', 'isolated'],
      ['sink', 'cycle-b'],
    ]);
  });

  it('pulls a source toward its successors so its edges stay short', () => {
    const nodes = ['a', 'b', 'c', 'late'].map((id) => ({ id, label: id }));
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'late', to: 'c' },
    ];
    // `late` has no predecessor; it sits just before `c`, not in the first layer.
    expect(layerIds(nodes, edges)).toEqual([['a'], ['b', 'late'], ['c']]);
  });

  it('stays fast for the largest allowed graph', () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({ id: `n${index}`, label: `N${index}` }));
    const edges: DiagramEdge[] = [];
    for (let index = 0; index < 200; index += 1) {
      const from = index % 100;
      const to = (index * 7 + 3) % 100;
      if (from !== to && !edges.some((edge) => edge.from === `n${from}` && edge.to === `n${to}`)) edges.push({ from: `n${from}`, to: `n${to}` });
    }
    const layers = layerIds(nodes, edges);
    expect(layers.flat()).toHaveLength(100);
  });
});
