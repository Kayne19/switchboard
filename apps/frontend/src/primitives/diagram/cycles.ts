// Stage 1 of the diagram layout: breaking cycles by reversing the back edges of a depth-first walk.
import type { DiagramEdge, DiagramNode } from '../../controller/types';

// --- Cycle removal ---------------------------------------------------------

export interface DirectedEdge {
  edge: DiagramEdge;
  /** Where the edge is laid out from: `edge.from`, or `edge.to` when reversed. */
  from: string;
  to: string;
  reversed: boolean;
}

/**
 * Orients every edge so the graph is acyclic: a depth-first walk from each
 * node in order reverses the edges that would close a loop. Self-loops are
 * left out; they span no layers.
 */
export function breakCycles(nodes: DiagramNode[], edges: DiagramEdge[]): DirectedEdge[] {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, number[]>(nodes.map((node) => [node.id, []]));
  const directed: DirectedEdge[] = [];
  edges.forEach((edge, index) => {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) return;
    outgoing.get(edge.from)?.push(index);
    directed[index] = { edge, from: edge.from, to: edge.to, reversed: false };
  });

  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const index of outgoing.get(id) ?? []) {
      const target = directed[index].to;
      const seen = state.get(target);
      if (seen === 'open') {
        directed[index] = { ...directed[index], from: target, to: id, reversed: true };
      } else if (seen === undefined) {
        visit(target);
      }
    }
    state.set(id, 'done');
  };
  for (const node of nodes) {
    if (!state.has(node.id)) visit(node.id);
  }
  return directed.filter(Boolean);
}
