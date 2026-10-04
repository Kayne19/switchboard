// Diagram geometry: which layer each node sits in, where it goes, how each
// edge is routed, and where its label sits. Pure, so the rules below can be
// checked without a browser.
//
// The layout is layered (Sugiyama-style) along a main axis (x in landscape,
// y in portrait) and spread along the cross axis:
// 1. Cycles are broken by reversing the back edges of a depth-first walk.
//    A reversed edge is laid out the other way round but drawn toward its
//    true target, so a feedback loop reads as a loop.
// 2. Each node takes the longest path from a source as its layer; a node
//    whose edges would get shorter is then pulled toward its successors.
// 3. An edge that spans more than one layer is routed through a dummy in
//    each layer it crosses, so it threads the gaps between that layer's
//    nodes and never passes through one.
// 4. Barycenter sweeps and adjacent swaps order each layer to reduce
//    crossings.
// 5. Each node's box is sized from its text (a monospace estimate, the same
//    way edge labels are measured); a layer stacks its boxes along the cross
//    axis, grows with them, and each node then settles toward its
//    neighbours as far as the ones beside it allow.
// 6. Routes are axis-aligned and bend in the gap between layers; bends that
//    would otherwise be ambiguous take their own track, and the gap grows to
//    hold its tracks and its labels. A label sits on its own route in the
//    gap, clear of the other labels and of the arrowheads at the gap's
//    ends, and clear of the other edges' lines where the gap leaves a spot
//    (otherwise on the spot that hides fewest).
// The drawing grows when the approved canvas is too small, and the SVG
// scales it to fit, rather than letting anything overlap.

import type { DiagramData, DiagramEdge, DiagramNode } from '../controller/types';

export type DiagramOrientation = 'landscape' | 'portrait';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeLine {
  kind: 'label' | 'sub' | 'detail';
  text: string;
  /** Baseline, relative to the box's top-left corner. */
  y: number;
}

export interface LaidOutNode {
  node: DiagramNode;
  layer: number;
  box: Box;
  /** The node's text, wrapped to the box; the renderer draws exactly these. */
  lines: NodeLine[];
  /** The rule under the label, relative to the box's top. */
  ruleY: number;
}

export interface EdgeLabel {
  text: string;
  /** The text as drawn: one or two lines, stacked about the centre. */
  lines: string[];
  /** The centre of the label's text. */
  x: number;
  y: number;
  /** The label's backing: what it paints over. */
  box: Box;
}

export interface LaidOutEdge {
  edge: DiagramEdge;
  /** Axis-aligned route from the source's outline to the target's. */
  points: Point[];
  label: EdgeLabel | null;
  /** Laid out against its direction to break a cycle; still drawn from `edge.from` to `edge.to`. */
  reversed: boolean;
}

export interface DiagramCallout {
  targetNodeId: string;
  box: Box;
  leader: Point[];
  placement: 'above' | 'below' | 'left' | 'right';
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  callout?: DiagramCallout | null;
}

// The approved canvas, in main/cross terms; the drawing grows past it when
// it must.
const CANVAS = {
  landscape: { main: 1000, cross: 620 },
  portrait: { main: 1000, cross: 700 },
} as const;
const PAD_MAIN = 28;
const PAD_CROSS = 32;

// Node text is set in the monospace face (.diagram-node-label, -sub,
// -detail); each line's advance is 0.6em plus its tracking, so a box's
// width is known before it is drawn. A line longer than its wrap width
// breaks at a space; a word longer than that widens the box instead.
const NODE_TEXT = {
  label: { advance: 10.8, lineHeight: 19, wrapAt: 14, maxLines: 2 },
  sub: { advance: 6.3, lineHeight: 13, wrapAt: 26, maxLines: 2 },
  detail: { advance: 4.8, lineHeight: 11, wrapAt: 36, maxLines: 2 },
} as const;
const NODE_PAD_SIDE = 18;
const NODE_MIN_WIDTH = 140;
const NODE_LABEL_BASELINE = 28;
const NODE_RULE_DROP = 11;
const NODE_SUB_DROP = 19;
const NODE_DETAIL_DROP = 18;
const NODE_PAD_BOTTOM = 12;
// Room beside the label for the corner tags: none, one (a state glyph or
// the note badge), or both side by side (the renderer draws the glyph left
// of the badge, 60 units in from the box's right edge).
const NODE_TAG_ROOM = [0, 30, 46] as const;

// Edge labels are set in the monospace face at 11 user units with 0.06em
// tracking (.diagram-edge-label), so a label's width is known before it is
// drawn: 0.6em advance plus the tracking, rounded up. A long label wraps to
// two lines so it costs its gap less room.
const LABEL_ADVANCE = 7.3;
const LABEL_HEIGHT = 14;
const LABEL_BACKING = 4;
const LABEL_WRAP_AT = 14;
const LABEL_MAX_LINES = 2;
// Space kept clear between a label's backing and anything else in its gap;
// a line passing a label keeps a little room from its backing too.
const CLEARANCE = 6;
const LINE_CLEARANCE = 2;
// How many spots a label tries on each run before settling.
const LABEL_STOPS = 24;
// An edge's arrowhead, in user units: the renderer draws it this long, and a
// label keeps clear of the gap's ends by this much so its backing never
// covers an arrowhead.
export const ARROW_LENGTH = 11;
const ARROW_ROOM = ARROW_LENGTH + 2;
// The narrowest gap between layers, labelled or not.
const MIN_GAP = 48;
// Distance between two bend tracks sharing a gap.
const TRACK_PITCH = 12;
// Space between boxes along the cross axis, and the most a sparse layer is
// spread beyond it to use the canvas.
const NODE_SPACING = 28;
const DUMMY_SPACING = 22;
const MAX_STRETCH = 72;
// A layer too crowded for the canvas is staggered into two rows along the
// main axis, its boxes interleaved so each back-row box sits behind the
// gap between two front-row boxes and its edges pass through that gap.
const STAGGER_FROM = 4;
const STAGGER_CLEARANCE = 12;
const ROW_GAP = 24;
// Where edges leave and enter a box: ports spread along its side.
const PORT_PITCH = 16;
const MIN_PORT_PITCH = 4;
const PORT_INSET = 14;
const SELF_LOOP = 18;

const EPSILON = 0.5;

// --- Text ------------------------------------------------------------------

function wrapGreedy(words: string[], wrapAt: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= wrapAt) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Breaks text at spaces into lines of at most `wrapAt` characters. Text
 * that would take more than `maxLines` lines is wrapped wider instead, at
 * the narrowest width that fits, so its lines stay balanced rather than
 * piling the rest onto the last one.
 */
function wrapLine(text: string, wrapAt: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  let lines = wrapGreedy(words, wrapAt);
  if (lines.length <= maxLines) return lines;
  // The line count only falls as the width grows; the whole text on one
  // line always fits.
  let low = wrapAt + 1;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (wrapGreedy(words, middle).length <= maxLines) high = middle;
    else low = middle + 1;
  }
  lines = wrapGreedy(words, low);
  return lines;
}

interface NodeText {
  width: number;
  height: number;
  lines: NodeLine[];
  ruleY: number;
}

export function measureNode(node: DiagramNode, cornerTags: 0 | 1 | 2): NodeText {
  const labelLines = wrapLine(node.label, NODE_TEXT.label.wrapAt, NODE_TEXT.label.maxLines);
  const subLines = node.sub ? wrapLine(node.sub, NODE_TEXT.sub.wrapAt, NODE_TEXT.sub.maxLines) : [];
  const detailLines = node.detail ? wrapLine(node.detail, NODE_TEXT.detail.wrapAt, NODE_TEXT.detail.maxLines) : [];

  const lines: NodeLine[] = [];
  let y = NODE_LABEL_BASELINE;
  labelLines.forEach((text, index) => {
    if (index > 0) y += NODE_TEXT.label.lineHeight;
    lines.push({ kind: 'label', text, y });
  });
  const ruleY = y + NODE_RULE_DROP;
  let last = ruleY;
  if (subLines.length) {
    y = ruleY + NODE_SUB_DROP;
    subLines.forEach((text, index) => {
      if (index > 0) y += NODE_TEXT.sub.lineHeight;
      lines.push({ kind: 'sub', text, y });
    });
    last = y;
  }
  if (detailLines.length) {
    y = subLines.length ? y + NODE_DETAIL_DROP : ruleY + NODE_SUB_DROP;
    detailLines.forEach((text, index) => {
      if (index > 0) y += NODE_TEXT.detail.lineHeight;
      lines.push({ kind: 'detail', text, y });
    });
    last = y;
  }

  const textWidth = Math.max(
    ...labelLines.map((line) => line.length * NODE_TEXT.label.advance + NODE_TAG_ROOM[cornerTags]),
    ...subLines.map((line) => line.length * NODE_TEXT.sub.advance),
    ...detailLines.map((line) => line.length * NODE_TEXT.detail.advance),
  );
  return {
    width: Math.max(NODE_MIN_WIDTH, Math.ceil(textWidth + 2 * NODE_PAD_SIDE)),
    height: last + NODE_PAD_BOTTOM,
    lines,
    ruleY,
  };
}

export function wrapEdgeLabel(text: string): string[] {
  return wrapLine(text, LABEL_WRAP_AT, LABEL_MAX_LINES);
}

function labelBacking(text: string) {
  const lines = wrapEdgeLabel(text);
  return {
    width: Math.max(...lines.map((line) => line.length)) * LABEL_ADVANCE + 2 * LABEL_BACKING,
    height: lines.length * LABEL_HEIGHT + 2 * LABEL_BACKING,
  };
}

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

// --- Layering --------------------------------------------------------------

/** Each node's layer: its longest path from a source, then pulled toward its successors where that shortens edges. */
function assignLayers(nodes: DiagramNode[], edges: DirectedEdge[]): Map<string, number> {
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

export function createLayers(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramNode[][] {
  if (nodes.length === 0) return [];
  const layer = assignLayers(nodes, breakCycles(nodes, edges));
  const count = Math.max(...layer.values()) + 1;
  const layers = Array.from({ length: count }, () => [] as DiagramNode[]);
  for (const node of nodes) layers[layer.get(node.id) ?? 0].push(node);
  return layers;
}

// --- The layered graph -----------------------------------------------------

interface Item {
  layer: number;
  index: number;
  /** Which row of a staggered layer the item sits in; a dummy spans both. */
  row: 0 | 1;
  staggered: boolean;
  /** The node, or null for a dummy an edge passes through. */
  node: DiagramNode | null;
  text: NodeText | null;
  mainExtent: number;
  crossExtent: number;
  main: number;
  cross: number;
  preds: Item[];
  succs: Item[];
}

interface Segment {
  edge: number;
  from: Item;
  to: Item;
  /** Where the segment leaves `from` and enters `to`, along the cross axis. */
  fromCross: number;
  toCross: number;
  /** The main coordinate of its bend, when it has one. */
  track: number | null;
}

interface Route {
  directed: DirectedEdge;
  segments: Segment[];
}

function meanOf(values: number[], fallback: number) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

// --- Ordering --------------------------------------------------------------

function crossingsBetween(upper: Item[]): number {
  const segments: Array<[number, number]> = [];
  for (const item of upper) for (const succ of item.succs) segments.push([item.index, succ.index]);
  let crossings = 0;
  for (let a = 0; a < segments.length; a += 1) {
    for (let b = a + 1; b < segments.length; b += 1) {
      if ((segments[a][0] - segments[b][0]) * (segments[a][1] - segments[b][1]) < 0) crossings += 1;
    }
  }
  return crossings;
}

function totalCrossings(layers: Item[][]): number {
  let total = 0;
  for (let index = 1; index < layers.length; index += 1) total += crossingsBetween(layers[index - 1]);
  return total;
}

function reindex(layer: Item[]) {
  layer.forEach((item, index) => {
    item.index = index;
  });
}

function barycenterSort(layer: Item[], neighbours: (item: Item) => Item[]) {
  const keyed = layer.map((item) => {
    const around = neighbours(item);
    return { item, key: around.length ? meanOf(around.map((n) => n.index), item.index) : item.index };
  });
  keyed.sort((a, b) => a.key - b.key || a.item.index - b.item.index);
  layer.splice(0, layer.length, ...keyed.map((entry) => entry.item));
  reindex(layer);
}

/** Crossings among the edges of two items in one layer, counting `v` as placed before `w`. */
function pairCrossings(v: Item, w: Item): number {
  let count = 0;
  for (const side of ['preds', 'succs'] as const) {
    for (const p of v[side]) for (const q of w[side]) if (p.index > q.index) count += 1;
  }
  return count;
}

function transpose(layer: Item[]) {
  let improved = true;
  while (improved) {
    improved = false;
    for (let index = 0; index + 1 < layer.length; index += 1) {
      const v = layer[index];
      const w = layer[index + 1];
      if (pairCrossings(w, v) < pairCrossings(v, w)) {
        layer[index] = w;
        layer[index + 1] = v;
        reindex(layer);
        improved = true;
      }
    }
  }
}

function orderLayers(layers: Item[][]) {
  for (const layer of layers) reindex(layer);
  let best = layers.map((layer) => [...layer]);
  let bestCrossings = totalCrossings(layers);
  for (let round = 0; round < 8 && bestCrossings > 0; round += 1) {
    const down = round % 2 === 0;
    if (down) {
      for (let index = 1; index < layers.length; index += 1) barycenterSort(layers[index], (item) => item.preds);
    } else {
      for (let index = layers.length - 2; index >= 0; index -= 1) barycenterSort(layers[index], (item) => item.succs);
    }
    for (const layer of layers) transpose(layer);
    const crossings = totalCrossings(layers);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = layers.map((layer) => [...layer]);
    }
  }
  best.forEach((layer, index) => {
    layers[index].splice(0, layers[index].length, ...layer);
    reindex(layers[index]);
  });
}

// --- Cross coordinates -----------------------------------------------------

function separation(a: Item, b: Item, stretch: number) {
  if (a.node && b.node && a.staggered && a.row !== b.row) {
    // Boxes in different rows may overlap along the cross axis; what must
    // stay clear is each box's centre line, where its edges run through
    // the other row.
    return Math.max(a.crossExtent, b.crossExtent) / 2 + STAGGER_CLEARANCE;
  }
  const spacing = a.node && b.node ? NODE_SPACING + stretch : DUMMY_SPACING;
  return a.crossExtent / 2 + spacing + b.crossExtent / 2;
}

/**
 * Settles each item of a layer toward its wanted position, as far as the
 * items beside it allow: an item already placed is a wall, one not yet
 * placed is pushed aside. Dummies go first so long edges stay straight,
 * then the nodes with most edges.
 */
function settleLayer(layer: Item[], wantedOf: (item: Item) => number | null, stretch: number) {
  const sep = (index: number) => separation(layer[index], layer[index + 1], stretch);
  // Neighbours that want the same spot (siblings of one parent) are centred
  // on it as a block rather than queueing behind the first of them.
  const targets = layer.map(wantedOf);
  for (let start = 0; start < layer.length; ) {
    let end = start;
    while (end + 1 < layer.length && targets[end + 1] !== null && targets[start] !== null && Math.abs((targets[end + 1] ?? 0) - (targets[start] ?? 0)) < EPSILON) end += 1;
    const centre = targets[start];
    if (end > start && centre !== null) {
      const offsets = [0];
      for (let k = start; k < end; k += 1) offsets.push(offsets[offsets.length - 1] + sep(k));
      const extent = offsets[offsets.length - 1];
      offsets.forEach((offset, k) => {
        targets[start + k] = centre - extent / 2 + offset;
      });
    }
    start = end + 1;
  }
  const wanted = (item: Item) => targets[item.index];
  const order = [...layer].sort((a, b) => {
    const dummy = Number(Boolean(b.node === null)) - Number(Boolean(a.node === null));
    if (dummy) return dummy;
    const degree = b.preds.length + b.succs.length - (a.preds.length + a.succs.length);
    return degree || a.index - b.index;
  });
  const fixed = layer.map(() => false);
  for (const item of order) {
    const i = item.index;
    const target = wanted(item);
    if (target !== null) {
      let low = -Infinity;
      let span = 0;
      for (let k = i - 1; k >= 0; k -= 1) {
        span += sep(k);
        if (fixed[k]) {
          low = layer[k].cross + span;
          break;
        }
      }
      let high = Infinity;
      span = 0;
      for (let k = i + 1; k < layer.length; k += 1) {
        span += sep(k - 1);
        if (fixed[k]) {
          high = layer[k].cross - span;
          break;
        }
      }
      item.cross = Math.min(high, Math.max(low, target));
      for (let k = i - 1; k >= 0 && !fixed[k]; k -= 1) layer[k].cross = Math.min(layer[k].cross, layer[k + 1].cross - sep(k));
      for (let k = i + 1; k < layer.length && !fixed[k]; k += 1) layer[k].cross = Math.max(layer[k].cross, layer[k - 1].cross + sep(k - 1));
    }
    fixed[i] = true;
  }
}

function assignCross(layers: Item[][], usableCross: number) {
  const stretches = layers.map((layer) => {
    const real = layer.filter((item) => item.node);
    if (real.length < 2) return 0;
    const natural = real.reduce((sum, item) => sum + item.crossExtent, 0) + NODE_SPACING * (real.length - 1);
    if (real.length >= STAGGER_FROM && natural > usableCross) {
      real.forEach((item, index) => {
        item.row = index % 2 === 0 ? 0 : 1;
      });
      for (const item of layer) item.staggered = true;
      return 0;
    }
    return Math.max(0, Math.min(MAX_STRETCH, (usableCross - natural) / (real.length - 1)));
  });
  layers.forEach((layer, index) => {
    const stretch = stretches[index];
    // Stack the layer from zero, then centre the stack on zero.
    let cursor = 0;
    layer.forEach((item, k) => {
      if (k > 0) cursor += separation(layer[k - 1], item, stretch);
      item.cross = cursor;
    });
    if (layer.length) {
      const first = layer[0];
      const last = layer[layer.length - 1];
      const shift = (first.cross - first.crossExtent / 2 + last.cross + last.crossExtent / 2) / 2;
      for (const item of layer) item.cross -= shift;
    }
  });

  // A node lines up with the nodes it is joined to; the dummies of edges
  // passing by only count when it has no such neighbour, so a long edge
  // skirting a node does not drag it off its line.
  const toward = (neighbours: Item[], item: Item) => {
    if (!neighbours.length) return null;
    const real = neighbours.filter((neighbour) => neighbour.node);
    return meanOf((real.length ? real : neighbours).map((neighbour) => neighbour.cross), item.cross);
  };
  const towardPreds = (item: Item) => toward(item.preds, item);
  const towardSuccs = (item: Item) => toward(item.succs, item);
  for (let round = 0; round < 2; round += 1) {
    for (let index = 1; index < layers.length; index += 1) settleLayer(layers[index], towardPreds, stretches[index]);
    for (let index = layers.length - 2; index >= 0; index -= 1) settleLayer(layers[index], towardSuccs, stretches[index]);
  }
}

// --- Ports and tracks ------------------------------------------------------

/** Spreads the segments leaving (or entering) each node along its side, in the order of their far ends. */
function assignPorts(layers: Item[][], segments: Segment[]) {
  for (const layer of layers) {
    for (const item of layer) {
      if (!item.node) continue;
      for (const side of ['out', 'in'] as const) {
        const ends = segments.filter((segment) => (side === 'out' ? segment.from : segment.to) === item);
        ends.sort((a, b) => {
          const farA = side === 'out' ? a.to.cross : a.from.cross;
          const farB = side === 'out' ? b.to.cross : b.from.cross;
          return farA - farB || a.edge - b.edge;
        });
        const count = ends.length;
        // A staggered box's edges run through the other row at its centre
        // line, so they share one port. So do ends too many for their side:
        // ports packed closer than a few units read as one striped band, so
        // they leave as one trunk and part where they bend.
        const spread = count > 1 && !item.staggered ? Math.min(PORT_PITCH, (item.crossExtent - 2 * PORT_INSET) / (count - 1)) : 0;
        const pitch = spread >= MIN_PORT_PITCH ? spread : 0;
        ends.forEach((segment, index) => {
          const cross = item.cross + (index - (count - 1) / 2) * pitch;
          if (side === 'out') segment.fromCross = cross;
          else segment.toCross = cross;
        });
      }
    }
  }
}

/**
 * Gives every bend in a gap a track. Two bends whose cross runs overlap
 * take different tracks, ordered so an edge that starts nearer the far
 * side of its run bends nearer its target: then its stubs cross no other
 * run. Returns the track count.
 */
function assignTracks(segments: Segment[]): number {
  const bent = segments.filter((segment) => Math.abs(segment.fromCross - segment.toCross) > 1e-6);
  // Bends that leave one shared port nest: the one going farthest bends
  // first, so no branch crosses another.
  const keyed = bent.map((segment) => ({
    segment,
    key: segment.toCross > segment.fromCross ? -segment.fromCross : segment.fromCross,
    far: segment.toCross > segment.fromCross ? -segment.toCross : segment.toCross,
    low: Math.min(segment.fromCross, segment.toCross),
    high: Math.max(segment.fromCross, segment.toCross),
    track: 0,
  }));
  keyed.sort((a, b) => a.key - b.key || a.far - b.far || a.segment.edge - b.segment.edge);
  let count = 0;
  keyed.forEach((entry, index) => {
    let track = 0;
    for (let other = 0; other < index; other += 1) {
      const earlier = keyed[other];
      if (earlier.low < entry.high && entry.low < earlier.high) track = Math.max(track, earlier.track + 1);
    }
    entry.track = track;
    entry.segment.track = track;
    count = Math.max(count, track + 1);
  });
  return count;
}

// --- Layout ----------------------------------------------------------------

type MainCross = [number, number];

function simplify(points: MainCross[]): MainCross[] {
  const out: MainCross[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-6 && Math.abs(last[1] - point[1]) < 1e-6) continue;
    const before = out[out.length - 2];
    if (
      last &&
      before &&
      ((Math.abs(before[0] - last[0]) < 1e-6 && Math.abs(last[0] - point[0]) < 1e-6) ||
        (Math.abs(before[1] - last[1]) < 1e-6 && Math.abs(last[1] - point[1]) < 1e-6))
    ) {
      out[out.length - 1] = point;
      continue;
    }
    out.push(point);
  }
  return out;
}

export function layoutDiagram(data: DiagramData, orientation: DiagramOrientation, anchorNodeId?: string): DiagramLayout {
  const canvas = CANVAS[orientation];
  const landscape = orientation === 'landscape';
  const point = (main: number, cross: number): Point => (landscape ? { x: main, y: cross } : { x: cross, y: main });
  // A label's extent along each axis. Text is always horizontal, so which
  // of its sides runs along the main axis depends on the orientation.
  const labelExtent = (text: string) => {
    const backing = labelBacking(text);
    return landscape ? { main: backing.width, cross: backing.height } : { main: backing.height, cross: backing.width };
  };

  // --- Nodes, layers, dummies ---------------------------------------------
  const directed = breakCycles(data.nodes, data.edges);
  const layerOf = assignLayers(data.nodes, directed);
  const layerCount = data.nodes.length ? Math.max(...layerOf.values()) + 1 : 0;
  const layers: Item[][] = Array.from({ length: layerCount }, () => []);
  const itemOf = new Map<string, Item>();
  // A done or blocked node carries its state glyph in its corner, and the
  // anchored node may carry the note badge there too.
  const cornerTagsOf = (node: DiagramNode): 0 | 1 | 2 => {
    const glyph = node.state === 'done' || node.state === 'blocked';
    const badge = node.id === anchorNodeId;
    return glyph && badge ? 2 : glyph || badge ? 1 : 0;
  };
  const makeItem = (layer: number, node: DiagramNode | null): Item => {
    const text = node ? measureNode(node, cornerTagsOf(node)) : null;
    const item: Item = {
      layer,
      index: layers[layer].length,
      row: 0,
      staggered: false,
      node,
      text,
      mainExtent: text ? (landscape ? text.width : text.height) : 0,
      crossExtent: text ? (landscape ? text.height : text.width) : 0,
      main: 0,
      cross: 0,
      preds: [],
      succs: [],
    };
    layers[layer].push(item);
    return item;
  };
  for (const node of data.nodes) itemOf.set(node.id, makeItem(layerOf.get(node.id) ?? 0, node));

  const routes: Route[] = [];
  const segments: Segment[] = [];
  const directedByEdge = new Map(directed.map((entry) => [entry.edge, entry]));
  data.edges.forEach((edge) => {
    const entry = directedByEdge.get(edge);
    if (!entry) return;
    const from = itemOf.get(entry.from);
    const to = itemOf.get(entry.to);
    if (!from || !to) return;
    const route: Route = { directed: entry, segments: [] };
    const routeIndex = routes.length;
    routes.push(route);
    let previous = from;
    for (let layer = from.layer + 1; layer <= to.layer; layer += 1) {
      const next = layer === to.layer ? to : makeItem(layer, null);
      const segment: Segment = { edge: routeIndex, from: previous, to: next, fromCross: 0, toCross: 0, track: null };
      previous.succs.push(next);
      next.preds.push(previous);
      route.segments.push(segment);
      segments.push(segment);
      previous = next;
    }
  });

  // --- Order and settle each layer -----------------------------------------
  orderLayers(layers);
  assignCross(layers, canvas.cross - 2 * PAD_CROSS);
  // A dummy that settled a hair off the line of its segment snaps onto it:
  // a route is straight or it bends, never a sliver of diagonal.
  for (const segment of segments) {
    if (Math.abs(segment.from.cross - segment.to.cross) > EPSILON) continue;
    if (!segment.to.node) segment.to.cross = segment.from.cross;
    else if (!segment.from.node) segment.from.cross = segment.to.cross;
  }
  for (const segment of segments) {
    segment.fromCross = segment.from.cross;
    segment.toCross = segment.to.cross;
  }
  assignPorts(layers, segments);

  // --- Gaps: tracks and labels, relative to each gap's centre -------------
  const gapIndexOf = (route: Route) => route.segments[0].from.layer + Math.floor((route.segments.length - 1) / 2);
  const gaps = Array.from({ length: Math.max(0, layerCount - 1) }, (_, gap) => {
    const own = segments.filter((segment) => segment.from.layer === gap);
    // A gap is measured from its centre, where its tracks are centred, out
    // to each of its ends: each side holds what reaches that way.
    return { tracks: assignTracks(own), before: MIN_GAP / 2, after: MIN_GAP / 2, centre: 0 };
  });
  const trackOffset = (segment: Segment) => ((segment.track ?? 0) - (gaps[segment.from.layer].tracks - 1) / 2) * TRACK_PITCH;

  // A label sits on its own route, mid-route in its gap: on its bend when it
  // has one, else on its straight run. Its backing hides whatever it covers,
  // so it keeps clear of the other labels in its gap and of the other
  // edges' lines there: a label that hid a line it does not name would read
  // as naming it. It tries the middle of its bend (or of its straight run)
  // first, then slides along the bend, then moves out along its run on
  // either side of the bend, which the gap grows to hold. When no spot is
  // clear of every line, it takes the first one clear of the other labels.
  interface PlacedLabel {
    text: string;
    gap: number;
    mainOffset: number;
    cross: number;
    extent: { main: number; cross: number };
  }
  // A straight run of one route inside a gap, relative to the gap's centre:
  // one along the main axis sits at a cross coordinate and spans main
  // offsets, a bend the other way round.
  interface GapLine {
    route: number;
    alongMain: boolean;
    at: number;
    low: number;
    high: number;
  }
  const linesOf = (segment: Segment): GapLine[] => {
    const route = segment.edge;
    if (segment.track === null) return [{ route, alongMain: true, at: segment.fromCross, low: -Infinity, high: Infinity }];
    const track = trackOffset(segment);
    return [
      { route, alongMain: true, at: segment.fromCross, low: -Infinity, high: track },
      { route, alongMain: false, at: track, low: Math.min(segment.fromCross, segment.toCross), high: Math.max(segment.fromCross, segment.toCross) },
      { route, alongMain: true, at: segment.toCross, low: track, high: Infinity },
    ];
  };
  const gapLines = gaps.map((_, gap) => segments.filter((segment) => segment.from.layer === gap).flatMap(linesOf));
  // Each gap's lines and placed labels, sorted by where they sit, so a spot
  // is checked only against the few near it: a crowded gap holds hundreds.
  const lowerBound = <T>(items: T[], value: number, key: (item: T) => number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (key(items[middle]) < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const byAt = (lines: GapLine[]) => [...lines].sort((a, b) => a.at - b.at);
  const gapIndex = gapLines.map((lines) => ({
    alongMain: byAt(lines.filter((line) => line.alongMain)),
    alongCross: byAt(lines.filter((line) => !line.alongMain)),
    /** By main offset. */
    labels: [] as PlacedLabel[],
    widest: 0,
  }));
  const placedLabels: PlacedLabel[] = [];
  const labelOf = new Map<Route, PlacedLabel>();
  routes.forEach((route, routeIndex) => {
    const text = route.directed.edge.label;
    if (!text) return;
    const gap = gapIndexOf(route);
    const mid = route.segments[gap - route.segments[0].from.layer];
    const extent = labelExtent(text);
    const place = (mainOffset: number, cross: number): PlacedLabel => ({ text, gap, mainOffset, cross, extent });
    const index = gapIndex[gap];
    const neighbours = index.labels;
    const clashes = (candidate: PlacedLabel) => {
      const reach = (index.widest + extent.main) / 2;
      for (let k = lowerBound(neighbours, candidate.mainOffset - reach, (other) => other.mainOffset); k < neighbours.length; k += 1) {
        const other = neighbours[k];
        if (other.mainOffset >= candidate.mainOffset + reach) break;
        if (
          Math.abs(other.mainOffset - candidate.mainOffset) < (other.extent.main + extent.main) / 2 &&
          Math.abs(other.cross - candidate.cross) < (other.extent.cross + extent.cross) / 2
        ) {
          return true;
        }
      }
      return false;
    };
    // Every other route's line counts, a trunk this route shares included:
    // a label on a shared run would read as naming every route on it. A
    // line passes under a label when it runs within the label's reach and
    // its span meets the label's.
    const hidden = (candidate: PlacedLabel, enough: number) => {
      let count = 0;
      const halfMain = extent.main / 2;
      const halfCross = extent.cross / 2;
      const along = index.alongMain;
      for (let k = lowerBound(along, candidate.cross - halfCross - LINE_CLEARANCE, (line) => line.at); k < along.length; k += 1) {
        const line = along[k];
        if (line.at >= candidate.cross + halfCross + LINE_CLEARANCE) break;
        if (line.route === routeIndex || Math.abs(line.at - candidate.cross) >= halfCross + LINE_CLEARANCE) continue;
        if (candidate.mainOffset + halfMain > line.low && candidate.mainOffset - halfMain < line.high && ++count >= enough) return count;
      }
      const across = index.alongCross;
      for (let k = lowerBound(across, candidate.mainOffset - halfMain - LINE_CLEARANCE, (line) => line.at); k < across.length; k += 1) {
        const line = across[k];
        if (line.at >= candidate.mainOffset + halfMain + LINE_CLEARANCE) break;
        if (line.route === routeIndex || Math.abs(line.at - candidate.mainOffset) >= halfMain + LINE_CLEARANCE) continue;
        if (candidate.cross + halfCross > line.low && candidate.cross - halfCross < line.high && ++count >= enough) return count;
      }
      return count;
    };
    // Stops are tried nearest `start` first, a bounded number of them, so a
    // crowded gap costs a few dozen tries per label rather than thousands.
    // `direction` keeps them to one side of the start, or 0 for both.
    const nearest = (stops: number[], start: number, direction: -1 | 0 | 1) => {
      const before = (a: number, b: number) => Math.abs(a - start) - Math.abs(b - start) || b - a;
      const kept: number[] = [];
      for (const stop of stops) {
        if (direction !== 0 && (stop - start) * direction < -1e-9) continue;
        if (kept.length === LABEL_STOPS && before(stop, kept[kept.length - 1]) >= 0) continue;
        let at = kept.length;
        while (at > 0 && before(stop, kept[at - 1]) < 0) at -= 1;
        kept.splice(at, 0, stop);
        if (kept.length > LABEL_STOPS) kept.pop();
      }
      return kept;
    };
    // Spots on a run along the main axis at `cross`: the start, and just
    // past each line crossing the run, each end of a line running along it,
    // and each label beside it (with a hair of room, so two never meet in
    // floating point). The last is past every label in the gap, so some
    // spot on the run is always clear of them.
    const alongRun = (cross: number, start: number, direction: -1 | 0 | 1): Array<[number, number]> => {
      const half = extent.main / 2 + LINE_CLEARANCE + 1;
      const stops = [start];
      for (const line of index.alongCross) {
        if (line.route !== routeIndex) stops.push(line.at + half, line.at - half);
      }
      const along = index.alongMain;
      for (let k = lowerBound(along, cross - extent.cross / 2 - LINE_CLEARANCE, (line) => line.at); k < along.length; k += 1) {
        const line = along[k];
        if (line.at >= cross + extent.cross / 2 + LINE_CLEARANCE) break;
        if (line.route === routeIndex) continue;
        if (Number.isFinite(line.high)) stops.push(line.high + half);
        if (Number.isFinite(line.low)) stops.push(line.low - half);
      }
      let beyond = start;
      for (const other of neighbours) {
        const apart = (other.extent.main + extent.main) / 2 + 2;
        stops.push(other.mainOffset + apart, other.mainOffset - apart);
        beyond = direction < 0 ? Math.min(beyond, other.mainOffset - apart) : Math.max(beyond, other.mainOffset + apart);
      }
      return [...nearest(stops, start, direction), beyond].map((main): [number, number] => [main, cross]);
    };
    let spots: Array<[number, number]>;
    if (mid.track === null) {
      spots = alongRun(mid.fromCross, 0, 0);
    } else {
      const track = trackOffset(mid);
      const low = Math.min(mid.fromCross, mid.toCross);
      const high = Math.max(mid.fromCross, mid.toCross);
      const anchor = (low + high) / 2;
      const half = extent.cross / 2 + LINE_CLEARANCE + 1;
      const crosses = [anchor];
      for (const line of index.alongMain) {
        if (line.route !== routeIndex) crosses.push(line.at + half, line.at - half);
      }
      const across = index.alongCross;
      for (let k = lowerBound(across, track - extent.main / 2 - LINE_CLEARANCE, (line) => line.at); k < across.length; k += 1) {
        const line = across[k];
        if (line.at >= track + extent.main / 2 + LINE_CLEARANCE) break;
        if (line.route !== routeIndex) crosses.push(line.high + half, line.low - half);
      }
      for (const other of neighbours) {
        const apart = (other.extent.cross + extent.cross) / 2 + 2;
        crosses.push(other.cross + apart, other.cross - apart);
      }
      const onBend = nearest(
        crosses.map((cross) => Math.min(high, Math.max(low, cross))),
        anchor,
        0,
      ).map((cross): [number, number] => [track, cross]);
      // Beside the bend: on the run toward the target, or back toward the
      // source, whichever is nearer the bend (the target's side on a tie).
      const reach = extent.main / 2 + CLEARANCE;
      const beside = [...alongRun(mid.toCross, track + reach, 1), ...alongRun(mid.fromCross, track - reach, -1)].sort(
        (a, b) => Math.abs(a[0] - track) - Math.abs(b[0] - track) || b[0] - a[0],
      );
      spots = [...onBend, ...beside];
    }
    // The first spot clear of the other labels and of every other line
    // wins; failing that, the spot clear of the labels that hides fewest.
    let label: PlacedLabel | null = null;
    let fallback: PlacedLabel | null = null;
    let fewest = Infinity;
    for (const [main, cross] of spots) {
      const candidate = place(main, cross);
      if (clashes(candidate)) continue;
      const count = hidden(candidate, fewest);
      if (count === 0) {
        label = candidate;
        break;
      }
      if (count < fewest) {
        fewest = count;
        fallback = candidate;
      }
    }
    label ??= fallback ?? place(...spots[0]);
    neighbours.splice(lowerBound(neighbours, label.mainOffset, (other) => other.mainOffset), 0, label);
    index.widest = Math.max(index.widest, extent.main);
    placedLabels.push(label);
    labelOf.set(route, label);
  });
  for (const gap of gaps) {
    const tracks = ((gap.tracks - 1) * TRACK_PITCH) / 2 + TRACK_PITCH + CLEARANCE;
    gap.before = Math.max(gap.before, tracks);
    gap.after = Math.max(gap.after, tracks);
  }
  for (const label of placedLabels) {
    const gap = gaps[label.gap];
    gap.before = Math.max(gap.before, label.extent.main / 2 - label.mainOffset + ARROW_ROOM);
    gap.after = Math.max(gap.after, label.mainOffset + label.extent.main / 2 + ARROW_ROOM);
  }

  // --- The main axis -------------------------------------------------------
  const rowExtent = (layer: Item[], row: 0 | 1) => Math.max(0, ...layer.filter((item) => item.row === row).map((item) => item.mainExtent));
  const bands = layers.map((layer) =>
    layer[0]?.staggered ? rowExtent(layer, 0) + ROW_GAP + rowExtent(layer, 1) : Math.max(0, ...layer.map((item) => item.mainExtent)),
  );
  const natural = bands.reduce((sum, band) => sum + band, 0) + gaps.reduce((sum, gap) => sum + gap.before + gap.after, 0) + 2 * PAD_MAIN;
  const stretch = gaps.length ? Math.max(0, (canvas.main - natural) / gaps.length) : 0;
  let cursor = PAD_MAIN;
  layers.forEach((layer, index) => {
    const front = rowExtent(layer, 0);
    for (const item of layer) {
      item.main = !item.staggered || !item.node ? cursor + bands[index] / 2 : item.row === 0 ? cursor + front / 2 : cursor + front + ROW_GAP + rowExtent(layer, 1) / 2;
    }
    cursor += bands[index];
    if (index < gaps.length) {
      const gap = gaps[index];
      gap.before += stretch / 2;
      gap.after += stretch / 2;
      gap.centre = cursor + gap.before;
      cursor += gap.before + gap.after;
    }
  });
  const mainSize = Math.max(canvas.main, layerCount ? cursor + PAD_MAIN : canvas.main);
  const trackMain = (segment: Segment) => gaps[segment.from.layer].centre + trackOffset(segment);

  // --- Routes ----------------------------------------------------------------
  const laidOut = routes.map((route) => {
    const points: MainCross[] = [];
    route.segments.forEach((segment, index) => {
      const exit = segment.from.node ? segment.from.main + segment.from.mainExtent / 2 : segment.from.main;
      const entrance = segment.to.node ? segment.to.main - segment.to.mainExtent / 2 : segment.to.main;
      if (index === 0) points.push([exit, segment.fromCross]);
      if (segment.track !== null) {
        const track = trackMain(segment);
        points.push([track, segment.fromCross], [track, segment.toCross]);
      }
      points.push([entrance, segment.toCross]);
    });
    const placed = labelOf.get(route);
    const label = placed ? { text: placed.text, main: gaps[placed.gap].centre + placed.mainOffset, cross: placed.cross } : null;
    return { route, points: simplify(points), label };
  });

  // Self-loops span no layers (and are refused upstream); one is drawn as a
  // small loop on its node's far side so it is not lost.
  const loopPoints = (edge: DiagramEdge): MainCross[] => {
    const item = itemOf.get(edge.from);
    if (!item) return [];
    const far = item.main + item.mainExtent / 2;
    return [
      [far, item.cross - 10],
      [far + SELF_LOOP, item.cross - 10],
      [far + SELF_LOOP, item.cross + 10],
      [far, item.cross + 10],
    ];
  };
  const loops = data.edges.filter((edge) => edge.from === edge.to && itemOf.has(edge.from)).map((edge) => ({ edge, points: loopPoints(edge) }));

  // --- Bounds and the canvas ----------------------------------------------
  let crossMin = Infinity;
  let crossMax = -Infinity;
  const include = (cross: number, extent = 0) => {
    crossMin = Math.min(crossMin, cross - extent / 2);
    crossMax = Math.max(crossMax, cross + extent / 2);
  };
  for (const layer of layers) for (const item of layer) if (item.node) include(item.cross, item.crossExtent);
  for (const { points, label } of laidOut) {
    for (const [, cross] of points) include(cross);
    if (label) include(label.cross, labelExtent(label.text).cross);
  }
  for (const loop of loops) for (const [, cross] of loop.points) include(cross);
  if (!Number.isFinite(crossMin)) {
    crossMin = 0;
    crossMax = 0;
  }
  const crossSize = Math.max(canvas.cross, crossMax - crossMin + 2 * PAD_CROSS);
  const crossShift = (crossSize - (crossMax - crossMin)) / 2 - crossMin;
  const place = (main: number, cross: number) => point(main, cross + crossShift);

  const width = landscape ? mainSize : crossSize;
  const height = landscape ? crossSize : mainSize;

  const nodes: LaidOutNode[] = data.nodes.flatMap((node) => {
    const item = itemOf.get(node.id);
    if (!item?.text) return [];
    const centre = place(item.main, item.cross);
    return [
      {
        node,
        layer: item.layer,
        box: { x: centre.x - item.text.width / 2, y: centre.y - item.text.height / 2, width: item.text.width, height: item.text.height },
        lines: item.text.lines,
        ruleY: item.text.ruleY,
      },
    ];
  });

  const laidOutByEdge = new Map<DiagramEdge, LaidOutEdge>();
  for (const { route, points, label } of laidOut) {
    const placed = points.map(([main, cross]) => place(main, cross));
    let edgeLabel: EdgeLabel | null = null;
    if (label) {
      const centre = place(label.main, label.cross);
      const backing = labelBacking(label.text);
      edgeLabel = {
        text: label.text,
        lines: wrapEdgeLabel(label.text),
        x: centre.x,
        y: centre.y,
        box: { x: centre.x - backing.width / 2, y: centre.y - backing.height / 2, ...backing },
      };
    }
    laidOutByEdge.set(route.directed.edge, {
      edge: route.directed.edge,
      points: route.directed.reversed ? placed.reverse() : placed,
      label: edgeLabel,
      reversed: route.directed.reversed,
    });
  }
  for (const loop of loops) {
    laidOutByEdge.set(loop.edge, { edge: loop.edge, points: loop.points.map(([main, cross]) => place(main, cross)), label: null, reversed: false });
  }
  const edges = data.edges.flatMap((edge) => laidOutByEdge.get(edge) ?? []);

  const callout = anchorNodeId ? placeCallout(nodes, edges, anchorNodeId, width, height, orientation) : null;

  return { width, height, nodes, edges, callout };
}

function boxesOverlap(a: Box, b: Box, clearance = 10): boolean {
  return !(
    a.x + a.width + clearance <= b.x ||
    b.x + b.width + clearance <= a.x ||
    a.y + a.height + clearance <= b.y ||
    b.y + b.height + clearance <= a.y
  );
}

export function placeCallout(
  nodes: LaidOutNode[],
  edges: LaidOutEdge[],
  targetNodeId: string,
  diagramWidth: number,
  diagramHeight: number,
  orientation: DiagramOrientation,
): DiagramCallout | null {
  if (orientation === 'portrait') return null;

  const target = nodes.find((n) => n.node.id === targetNodeId);
  if (!target) return null;

  const calloutWidth = 240;
  const calloutHeight = 80;
  const { box } = target;
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  const clampX = (x: number) => Math.max(10, Math.min(diagramWidth - calloutWidth - 10, x));
  const clampY = (y: number) => Math.max(10, Math.min(diagramHeight - calloutHeight - 10, y));

  // Each side of the node is tried centred first, then with the callout
  // slid to the node's start or end, then again on a longer leader, so a
  // crowded neighbour on one side does not send the note back to the rail
  // while another spot is free.
  type Placement = DiagramCallout['placement'];
  const candidates: Array<{ placement: Placement; box: Box; leader: Point[] }> = [];
  for (const [gap, align] of [20, 64, 112].flatMap((distance) => (['centre', 'start', 'end'] as const).map((side) => [distance, side] as const))) {
    const alongX =
      align === 'centre' ? clampX(box.x + (box.width - calloutWidth) / 2) : align === 'start' ? box.x : box.x + box.width - calloutWidth;
    const alongY =
      align === 'centre' ? clampY(box.y + (box.height - calloutHeight) / 2) : align === 'start' ? box.y : box.y + box.height - calloutHeight;
    const vertical = (placement: 'above' | 'below') => {
      const y = placement === 'above' ? box.y - gap - calloutHeight : box.y + box.height + gap;
      const edge = placement === 'above' ? box.y : box.y + box.height;
      const outer = placement === 'above' ? y + calloutHeight : y;
      return { placement, box: { x: alongX, y, width: calloutWidth, height: calloutHeight }, leader: [{ x: centreX, y: outer }, { x: centreX, y: edge }] };
    };
    const horizontal = (placement: 'left' | 'right') => {
      const x = placement === 'left' ? box.x - gap - calloutWidth : box.x + box.width + gap;
      const edge = placement === 'left' ? box.x : box.x + box.width;
      const outer = placement === 'left' ? x + calloutWidth : x;
      return { placement, box: { x, y: alongY, width: calloutWidth, height: calloutHeight }, leader: [{ x: outer, y: centreY }, { x: edge, y: centreY }] };
    };
    candidates.push(vertical('above'), vertical('below'), horizontal('right'), horizontal('left'));
  }

  for (const cand of candidates) {
    if (
      cand.box.x < 10 ||
      cand.box.x + cand.box.width > diagramWidth - 10 ||
      cand.box.y < 10 ||
      cand.box.y + cand.box.height > diagramHeight - 10
    ) {
      continue;
    }
    const overlapsOtherNode = nodes.some(
      (n) => n.node.id !== targetNodeId && boxesOverlap(cand.box, n.box, 12),
    );
    if (overlapsOtherNode) continue;

    const overlapsLabel = edges.some(
      (e) => e.label && boxesOverlap(cand.box, e.label.box, 8),
    );
    if (overlapsLabel) continue;

    return {
      targetNodeId,
      box: cand.box,
      leader: cand.leader,
      placement: cand.placement,
    };
  }

  return null;
}
