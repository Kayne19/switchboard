import { describe, expect, it } from 'vitest';
import { breakCycles } from '../../src/primitives/diagram/cycles';

describe('cycle removal', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id }));

  it('reverses only the edges that close a loop', () => {
    const directed = breakCycles(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'c', to: 'd' },
    ]);
    expect(directed.map((entry) => [entry.from, entry.to, entry.reversed])).toEqual([
      ['a', 'b', false],
      ['b', 'c', false],
      ['a', 'c', true],
      ['c', 'd', false],
    ]);
  });

  it('leaves self-loops and edges to unknown nodes out', () => {
    const directed = breakCycles(nodes, [
      { from: 'a', to: 'a' },
      { from: 'a', to: 'zzz' },
      { from: 'a', to: 'b' },
    ]);
    expect(directed).toHaveLength(1);
    expect(directed[0].edge).toEqual({ from: 'a', to: 'b' });
  });
});
