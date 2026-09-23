import { describe, expect, it } from 'vitest';
import { createLayers } from '../../src/primitives/DiagramPrimitive';
import type { DiagramEdge, DiagramNode } from '../../src/controller/types';

function layerIds(nodes: DiagramNode[], edges: DiagramEdge[]) {
  const started = performance.now();
  const layers = createLayers(nodes, edges);
  expect(performance.now() - started).toBeLessThan(10);
  return layers.map((layer) => layer.map((node) => node.id));
}

describe('diagram layering', () => {
  it('terminates for self-loops and pure cycles', () => {
    expect(
      layerIds([{ id: 'a', label: 'A' }], [{ from: 'a', to: 'a' }]),
    ).toEqual([['a']]);

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
    ).toEqual([['a', 'b']]);
  });

  it('places a rooted feedback component after its external root', () => {
    const nodes = ['root', 'a', 'b', 'c'].map((id) => ({ id, label: id }));
    const edges = [
      { from: 'root', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ];

    expect(layerIds(nodes, edges)).toEqual([['root'], ['a', 'b', 'c']]);
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
      ['source', 'cycle-a', 'cycle-b', 'isolated'],
      ['sink'],
    ]);
  });
});
