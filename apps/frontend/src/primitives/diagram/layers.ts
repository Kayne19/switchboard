// Stage 2 of the diagram layout: layer assignment, wrapping a layer too wide for its frame, and choosing the edges drawn as stubs.
import type { DiagramNode } from '../../controller/types';
import type { DirectedEdge } from './cycles';
import type { Packing } from './shared';
import { ARROW_ROOM, CLEARANCE, NODE_SPACING, STAGGER_CLEARANCE, STAGGER_FROM, STUB_FROM, STUB_MIN_SPAN, TRACK_PITCH } from './shared';

// --- Layering --------------------------------------------------------------

/** Each node's layer: its longest path from a source, then pulled toward its successors where that shortens edges. */
export function assignLayers(nodes: DiagramNode[], edges: DirectedEdge[]): Map<string, number> {
  const preds = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const succs = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    preds.get(edge.to)?.push(edge.from);
    succs.get(edge.from)?.push(edge.to);
  }

  const indegree = new Map(nodes.map((node) => [node.id, preds.get(node.id)?.length ?? 0]));
  const order: string[] = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (let cursor = 0; cursor < order.length; cursor += 1) {
    for (const child of succs.get(order[cursor]) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) order.push(child);
    }
  }

  const layer = new Map(nodes.map((node) => [node.id, 0]));
  for (const id of order) {
    for (const child of succs.get(id) ?? []) {
      layer.set(child, Math.max(layer.get(child) ?? 0, (layer.get(id) ?? 0) + 1));
    }
  }
  // A node moves up to sit just before its nearest successor when that
  // shortens more edges than it lengthens.
  for (const id of [...order].reverse()) {
    const out = succs.get(id) ?? [];
    const into = preds.get(id) ?? [];
    if (out.length === 0 || (into.length > 0 && out.length <= into.length)) continue;
    const candidate = Math.min(...out.map((child) => layer.get(child) ?? 0)) - 1;
    if (candidate > (layer.get(id) ?? 0)) layer.set(id, candidate);
  }
  // Drop any layer left empty by the move.
  const used = [...new Set(layer.values())].sort((a, b) => a - b);
  const compact = new Map(used.map((value, index) => [value, index]));
  for (const [id, value] of layer) layer.set(id, compact.get(value) ?? 0);
  return layer;
}

// --- Wrapping a layer too wide for its frame --------------------------------

/** One edge of the layered graph, by the ids of what it joins: a node, or a stub's terminal. */
export interface Link {
  from: string;
  to: string;
  /** Drawn against the layout's direction: its arrowhead is at `from`. */
  reversed: boolean;
}

// The room a part of a layer takes across: its boxes and the spacing
// between them, and a dummy's spacing for each edge passing through it.
export function partRoom(part: string[], through: number, extentOf: (id: string) => number, packing: Packing) {
  const lanes = through > 0 ? (through + 1) * packing.dummy : 0;
  return part.reduce((sum, id) => sum + extentOf(id), 0) + NODE_SPACING * Math.max(0, part.length - 1) + lanes;
}

// Each layer's members, and how many links pass through it.
export function layerMembers(ids: string[], links: Link[], layerOf: Map<string, number>) {
  const count = ids.length ? Math.max(...ids.map((id) => layerOf.get(id) ?? 0)) + 1 : 0;
  const members: string[][] = Array.from({ length: count }, () => []);
  for (const id of ids) members[layerOf.get(id) ?? 0].push(id);
  const passing = new Array<number>(count).fill(0);
  for (const link of links) {
    for (let layer = (layerOf.get(link.from) ?? 0) + 1; layer < (layerOf.get(link.to) ?? 0); layer += 1) passing[layer] += 1;
  }
  return { members, passing };
}

/**
 * Splits each layer too wide for the frame's cross axis into consecutive
 * layers that fit it, and renumbers the layers after it. A member's edges
 * then pass the other parts of its old layer as long edges do, through the
 * gaps between their boxes, so they are counted against each part's room.
 * Members go in the order of their pins (`pinOf`: below 0 toward the first
 * part, above 0 toward the last); among equals, members with more edges in
 * than out go first, so the fewest edges have far to run. A layer that fits,
 * and a lone member too wide for any part, stay as they are; so does a
 * layer of nodes alone that fits staggered into two rows (`assignCross`).
 */
export function wrapLayers(
  ids: string[],
  links: Link[],
  layerOf: Map<string, number>,
  extentOf: (id: string) => number,
  usable: number,
  packing: Packing,
  canStagger: (id: string) => boolean,
  facingOf: (id: string) => number,
  pinOf: (id: string) => number,
) {
  const { members, passing } = layerMembers(ids, links, layerOf);
  const inward = new Map<string, number>();
  const outward = new Map<string, number>();
  for (const link of links) {
    outward.set(link.from, (outward.get(link.from) ?? 0) + 1);
    inward.set(link.to, (inward.get(link.to) ?? 0) + 1);
  }
  const room = (part: string[], through: number) => partRoom(part, through, extentOf, packing);
  // A layer crowded enough to stagger into two rows takes about half.
  const staggered = (part: string[], through: number) => {
    if (part.length < STAGGER_FROM || !part.every(canStagger)) return Infinity;
    const widest = Math.max(...part.map(extentOf));
    const facing = Math.max(...part.map(facingOf));
    return (part.length - 1) * (widest / 2 + facing + STAGGER_CLEARANCE) + widest + (through > 0 ? (through + 1) * packing.dummy : 0);
  };
  let shift = 0;
  members.forEach((part, layer) => {
    if (room(part, passing[layer]) <= usable || staggered(part, passing[layer]) <= usable || part.length < 2) {
      for (const id of part) layerOf.set(id, layer + shift);
      return;
    }
    const order = part
      .map((id, index) => ({ id, index, pin: pinOf(id), lean: (outward.get(id) ?? 0) - (inward.get(id) ?? 0) }))
      .sort((a, b) => a.pin - b.pin || a.lean - b.lean || a.index - b.index)
      .map((entry) => entry.id);
    // Edges into the members still to place pass this part; so do the
    // edges out of the members placed in parts before it.
    let waitingIn = order.reduce((sum, id) => sum + (inward.get(id) ?? 0), 0);
    let doneOut = 0;
    let index = 0;
    let cursor = 0;
    while (cursor < order.length) {
      const taken = [order[cursor]];
      waitingIn -= inward.get(order[cursor]) ?? 0;
      cursor += 1;
      while (cursor < order.length) {
        const next = order[cursor];
        const through = passing[layer] + waitingIn - (inward.get(next) ?? 0) + doneOut;
        if (room([...taken, next], through) > usable) break;
        taken.push(next);
        waitingIn -= inward.get(next) ?? 0;
        cursor += 1;
      }
      for (const id of taken) {
        layerOf.set(id, layer + shift + index);
        doneOut += outward.get(id) ?? 0;
      }
      index += 1;
    }
    shift += index - 1;
  });
}

// --- Edges too long to follow ------------------------------------------------

/**
 * The edges a frame draws as stub pairs: those whose run along the main
 * axis would be longer than the frame itself. A reader follows an edge by
 * keeping both its ends in view; past one frame's length they cannot, and
 * the line has to be tracked through the scroll among its neighbours. Such
 * an edge leaves its source as a short stub naming its target and arrives
 * at its target from a stub naming its source. The run is estimated from
 * the layers before anything is placed: each layer as deep as its deepest
 * box, each gap as deep as the tracks and the widest label it is likely to
 * hold. An edge that skips fewer than STUB_MIN_SPAN layers is never a stub:
 * its stubs would take as much room as its line.
 */
export function chooseStubs(
  edges: DirectedEdge[],
  links: Link[],
  layerOf: Map<string, number>,
  mainExtentOf: (id: string) => number,
  labelMainOf: (text: string) => number,
  window: number,
  packing: Packing,
): Set<DirectedEdge> {
  const stubs = new Set<DirectedEdge>();
  if (!edges.length) return stubs;
  const count = Math.max(...layerOf.values()) + 1;
  const band = new Array<number>(count).fill(0);
  for (const [id, layer] of layerOf) band[layer] = Math.max(band[layer], mainExtentOf(id));
  const through = new Array<number>(Math.max(0, count - 1)).fill(0);
  const widest = new Array<number>(Math.max(0, count - 1)).fill(0);
  for (const link of links) {
    for (let gap = layerOf.get(link.from) ?? 0; gap < (layerOf.get(link.to) ?? 0); gap += 1) through[gap] += 1;
  }
  for (const edge of edges) {
    const from = layerOf.get(edge.from) ?? 0;
    const to = layerOf.get(edge.to) ?? 0;
    const label = edge.edge.label;
    if (label && to > from) {
      const gap = from + Math.floor((to - from - 1) / 2);
      widest[gap] = Math.max(widest[gap], labelMainOf(label));
    }
  }
  const start: number[] = [];
  const end: number[] = [];
  let cursor = 0;
  for (let layer = 0; layer < count; layer += 1) {
    start.push(cursor);
    cursor += band[layer];
    end.push(cursor);
    if (layer < count - 1) {
      // About half the edges crossing a gap bend in it, each on its own track.
      const tracks = (through[layer] * TRACK_PITCH) / 2 + 2 * (TRACK_PITCH + CLEARANCE);
      cursor += Math.max(packing.minGap, tracks, widest[layer] ? widest[layer] + 2 * ARROW_ROOM : 0);
    }
  }
  // A drawing at most STUB_FROM frames long keeps every edge whole: one
  // scroll brings any far end into view.
  if (cursor <= STUB_FROM * window) return stubs;
  for (const edge of edges) {
    const from = layerOf.get(edge.from) ?? 0;
    const to = layerOf.get(edge.to) ?? 0;
    if (to - from >= STUB_MIN_SPAN && start[to] - end[from] > window) stubs.add(edge);
  }
  return stubs;
}
