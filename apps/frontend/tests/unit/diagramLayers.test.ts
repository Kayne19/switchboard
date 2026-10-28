import { describe, expect, it } from 'vitest';
import type { DirectedEdge } from '../../src/primitives/diagram/cycles';
import { assignLayers, chooseStubs, layerMembers, partRoom, wrapLayers, type Link } from '../../src/primitives/diagram/layers';
import type { Packing } from '../../src/primitives/diagram/shared';

const packing: Packing = { dummy: 22, padCross: 32, padMain: 28, minGap: 48, maxGapStretch: 72 };
const nodes = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const directed = (...pairs: Array<[string, string]>): DirectedEdge[] => pairs.map(([from, to]) => ({ from, to, reversed: false, edge: { from, to } }));
const layersOf = (map: Map<string, number>) => Object.fromEntries(map);

describe('assignLayers', () => {
  it('puts each node one layer after its deepest predecessor', () => {
    const layers = assignLayers(nodes('a', 'b', 'c'), directed(['a', 'b'], ['b', 'c'], ['a', 'c']));
    expect(layersOf(layers)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it('pulls a source toward its successor when that shortens its edge', () => {
    const layers = assignLayers(nodes('a', 'b', 'c', 'd', 'e'), directed(['a', 'b'], ['b', 'c'], ['c', 'd'], ['e', 'd']));
    expect(layersOf(layers)).toEqual({ a: 0, b: 1, c: 2, d: 3, e: 2 });
  });

  it('leaves no layer empty', () => {
    const layers = assignLayers(nodes('a', 'b', 'c'), directed(['a', 'b']));
    expect([...new Set(layers.values())].sort()).toEqual([0, 1]);
  });
});

describe('layerMembers and partRoom', () => {
  it('lists each layer and counts the links passing through it', () => {
    const links: Link[] = [{ from: 'a', to: 'c', reversed: false }];
    const layerOf = new Map([['a', 0], ['b', 1], ['c', 2]]);
    expect(layerMembers(['a', 'b', 'c'], links, layerOf)).toEqual({ members: [['a'], ['b'], ['c']], passing: [0, 1, 0] });
  });

  it('adds the node spacing between boxes and a dummy lane for each link passing through', () => {
    const extentOf = () => 40;
    expect(partRoom(['a', 'b'], 0, extentOf, packing)).toBe(40 + 40 + 28);
    expect(partRoom(['a', 'b'], 2, extentOf, packing)).toBe(40 + 40 + 28 + 3 * 22);
  });
});

describe('wrapLayers', () => {
  const wide = (usable: number, ids = ['x', 'y', 'z'], pinOf: (id: string) => number = () => 0, canStagger: (id: string) => boolean = () => false) => {
    const layerOf = new Map(ids.map((id) => [id, 0]));
    wrapLayers(ids, [], layerOf, () => 100, usable, packing, canStagger, () => 0, pinOf);
    return layersOf(layerOf);
  };

  it('leaves a layer that fits where it is', () => {
    expect(wide(400)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('splits a layer too wide into consecutive layers that each fit', () => {
    expect(wide(250)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('places members in the order of their pins', () => {
    expect(wide(250, ['x', 'y', 'z'], (id) => (id === 'z' ? -1 : 0))).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('keeps a crowded layer of nodes whole when two staggered rows fit', () => {
    expect(wide(330, ['p', 'q', 'r', 's'], () => 0, () => true)).toEqual({ p: 0, q: 0, r: 0, s: 0 });
  });

  it('renumbers the layers after a split', () => {
    const layerOf = new Map([['x', 0], ['y', 0], ['z', 0], ['w', 1]]);
    wrapLayers(['x', 'y', 'z', 'w'], [], layerOf, () => 100, 250, packing, () => false, () => 0, () => 0);
    expect(layersOf(layerOf)).toEqual({ x: 0, y: 0, z: 1, w: 2 });
  });

  it('keeps a lone member too wide for any part', () => {
    const layerOf = new Map([['x', 0]]);
    wrapLayers(['x'], [], layerOf, () => 500, 250, packing, () => false, () => 0, () => 0);
    expect(layersOf(layerOf)).toEqual({ x: 0 });
  });
});

describe('chooseStubs', () => {
  const chain = ['a', 'b', 'c', 'd', 'e'];
  const layerOf = new Map(chain.map((id, index) => [id, index]));
  const edges = directed(['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['a', 'c'], ['a', 'e']);
  const links: Link[] = edges.map(({ from, to }) => ({ from, to, reversed: false }));
  const stubsIn = (window: number) => [...chooseStubs(edges, links, layerOf, () => 100, () => 0, window, packing)].map(({ from, to }) => `${from}${to}`);

  it('keeps every edge whole in a drawing at most two frames long', () => {
    expect(stubsIn(400)).toEqual([]);
  });

  // Layers are 100 deep and the gaps 54, 54, 48 and 48 (a gap grows with the tracks of the links through it).
  it('stubs an edge that skips layers and runs past one frame', () => {
    expect(stubsIn(210)).toEqual(['ae']);
  });

  it('stubs a shorter skipping edge once its run passes the frame', () => {
    expect(stubsIn(200)).toEqual(['ac', 'ae']);
  });

  it('never stubs an edge between adjacent layers', () => {
    expect(stubsIn(60).every((pair) => !['ab', 'bc', 'cd', 'de'].includes(pair))).toBe(true);
  });

  it('returns no stubs for no edges', () => {
    expect(chooseStubs([], [], new Map(), () => 0, () => 0, 100, packing).size).toBe(0);
  });
});
