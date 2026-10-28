// The layered graph that ordering, placement and routing share: items (nodes, dummies, terminals), segments and routes.
import type { DiagramNode } from '../../controller/types';
import type { NodeText } from './node';

// --- The layered graph -----------------------------------------------------

/**
 * The open end of a stub: a label naming the far ends of the edges it
 * stands for, in the layer next to its node (`out`: after it, `in`: before
 * it), or one further when a wrapped layer leaves no room there.
 */
export interface Terminal {
  text: string;
  lines: string[];
  /** Which lines are an edge's own label under the name it is on, set quieter. */
  quiet: boolean[];
  width: number;
  height: number;
  side: 'out' | 'in';
}

export interface Item {
  layer: number;
  index: number;
  /** Which row of a staggered layer the item sits in; a dummy spans both. */
  row: 0 | 1;
  staggered: boolean;
  /** The node, or null for a dummy an edge passes through or a stub's terminal. */
  node: DiagramNode | null;
  /** The label at a stub's open end, or null for a node or a dummy. */
  terminal: Terminal | null;
  text: NodeText | null;
  mainExtent: number;
  crossExtent: number;
  /** In a staggered layer, half the spread of the ports on the side whose lines pass through the other row. */
  facingHalf: number;
  main: number;
  cross: number;
  preds: Item[];
  succs: Item[];
  /** The segments leaving it and entering it. */
  outs: Segment[];
  ins: Segment[];
}

export const isDummy = (item: Item) => item.node === null && item.terminal === null;

export interface Segment {
  /** Its route's index. */
  edge: number;
  from: Item;
  to: Item;
  /** Where the segment leaves `from` and enters `to`, along the cross axis. */
  fromCross: number;
  toCross: number;
  /** The main coordinate of its bend, when it has one. */
  track: number | null;
  /** Its edge is drawn against the layout's direction (a broken cycle). */
  reversed: boolean;
}

/** A drawn line: an edge drawn whole, or a stub between a node and its terminal. */
export interface Route {
  /** Laid out against the edge's direction: drawn from its last point to its first. */
  reversed: boolean;
  /** An edge's own label; a stub's names are on its terminal. */
  label: string | null;
  segments: Segment[];
}

export function meanOf(values: number[], fallback: number) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}
