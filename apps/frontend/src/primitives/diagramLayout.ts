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
// 4. Barycenter sweeps, adjacent swaps and sifting order each layer to
//    reduce crossings, from several starting orders (`orderLayers`).
// 5. Each node's box is sized from its text (a monospace estimate, the same
//    way edge labels are measured) and grows along a side too short for a
//    port of its own per edge end; a layer stacks its boxes along the cross
//    axis, grows with them, and each node then settles toward its
//    neighbours as far as the ones beside it allow.
// 6. Routes are axis-aligned and bend in the gap between layers; bends that
//    would otherwise be ambiguous take their own track, and the gap grows to
//    hold its tracks and its labels. A label sits on its own route in the
//    gap, clear of the other labels and of the arrowheads at the gap's
//    ends, and clear of the other edges' lines where the gap leaves a spot
//    (otherwise on the spot that hides fewest).
// The drawing grows when the approved canvas is too small rather than
// letting anything overlap. Shown in a viewport (`viewDiagram`), a drawing
// too large to read whole there is laid out again for a frame of the
// viewport's size and scrolls (drawingFit.ts). Laid out for a frame, an
// edge longer than the frame, or one of too many running side by side, is
// drawn as a stub pair naming its far ends (`chooseStubs`, `bundledEdges`).

import type { DiagramData, DiagramEdge, DiagramNode } from '../controller/types';
import { LABEL_BACKING, drawingOrientation, labelBox, steppedFrame } from './drawingKit';
import { fitDrawing, readableScale, scrollCost, type DrawingFit, type Viewport } from './drawingFit';
import { NOTE_MARKER } from './NoteMarker';

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

/**
 * One end of an edge too long to follow, drawn as a short stub: from its
 * true source out to a label naming the target (`-> target`), or from a
 * label naming the source (`source ->`) in to its true target.
 */
export interface EdgeStub {
  /** Axis-aligned, in the edge's own direction: from the source's outline to the label, or from the label to the target's. */
  points: Point[];
  /**
   * The label at the stub's open end; the line meets its backing. The
   * stubs leaving one side of a node the same way share one, which lists
   * every far end, each edge's own label under its name.
   */
  label: EdgeLabel;
  /** Which side of the label its lines line up on: the side the stub meets. */
  align: 'start' | 'middle' | 'end';
  /** For each of the label's lines, whether it is an edge's own label (under the name it belongs to), set quieter than the names. */
  quiet: boolean[];
}

export interface LaidOutEdge {
  edge: DiagramEdge;
  /** Axis-aligned route from the source's outline to the target's; empty for an edge drawn as stubs. */
  points: Point[];
  /** The edge's own label on its route; an edge drawn as stubs carries it in their names. */
  label: EdgeLabel | null;
  /** Laid out against its direction to break a cycle; still drawn from `edge.from` to `edge.to`. */
  reversed: boolean;
  /** An edge longer than the frame it is read in is drawn as a stub at each end instead of a route (`chooseStubs`). */
  stubs: { from: EdgeStub; to: EdgeStub } | null;
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

// A node's frame is its box with the top-left and top-right corners cut and
// the bottom-left stepped; the renderer draws exactly this outline.
const FRAME_CUT = { topLeft: 14, topRight: 22, bottomLeft: 18 } as const;

export function nodeFramePath(width: number, height: number): string {
  return steppedFrame(width, height, FRAME_CUT);
}

// The tags in a node's top-right corner: the state glyph of a done or
// blocked node, and the NOTE marker of the node a rail note names. They
// stand in one row under the frame's top edge that ends TAG_INSET short of
// where the top-right cut begins, the marker outermost, so at any box size
// neither reaches the cut; the label's measured width keeps TAG_GAP clear
// of the row (`measureNode`).
const TAG_SIZE = { glyph: { width: 18, height: 15 }, marker: NOTE_MARKER } as const;
const TAG_TOP = 6;
const TAG_INSET = 6;
const TAG_GAP = 6;

export interface CornerTags {
  glyph: boolean;
  marker: boolean;
}

export interface CornerTagBoxes {
  glyph: Box | null;
  marker: Box | null;
}

/** Where a node's corner tags go, relative to its box's top-left corner. */
export function cornerTagBoxes(width: number, tags: CornerTags): CornerTagBoxes {
  let right = width - FRAME_CUT.topRight - TAG_INSET;
  const place = (size: { width: number; height: number }): Box => {
    const box = { x: right - size.width, y: TAG_TOP, width: size.width, height: size.height };
    right = box.x - TAG_GAP;
    return box;
  };
  const marker = tags.marker ? place(TAG_SIZE.marker) : null;
  const glyph = tags.glyph ? place(TAG_SIZE.glyph) : null;
  return { glyph, marker };
}

// Room the label's lines leave beside them for the tag row: the row's reach
// in from the box's right edge, and a gap, less the side padding the box
// already has.
function tagRoom(tags: CornerTags): number {
  if (!tags.glyph && !tags.marker) return 0;
  const boxes = cornerTagBoxes(0, tags);
  const left = Math.min(...[boxes.glyph, boxes.marker].flatMap((box) => (box ? [box.x] : [])));
  return -left + TAG_GAP - NODE_PAD_SIDE;
}

// A long edge label wraps to two lines so it costs its gap less room.
/** Where a label's text starts inside its backing, for text lined up on one side. */
export const LABEL_INSET = LABEL_BACKING;
const LABEL_WRAP_AT = 14;
const LABEL_MAX_LINES = 2;
// Space kept clear between a label's backing and anything else in its gap;
// a line passing a label keeps a little room from its backing too.
const CLEARANCE = 6;
const LINE_CLEARANCE = 2;
// A label moved off the middle of its line keeps the line this far inside
// its backing's edge.
const LABEL_HOLD = 10;
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
// How closely a drawing is packed across: on the approved canvas, and when
// it is laid out for the frame it will be read in at its readable minimum,
// where room across is what keeps it from scrolling both ways. There the
// lines of long edges run as a bundle, a few pixels apart on screen.
interface Packing {
  dummy: number;
  padCross: number;
  padMain: number;
  minGap: number;
  maxGapStretch: number;
}
const APPROVED_PACKING: Packing = { dummy: DUMMY_SPACING, padCross: PAD_CROSS, padMain: PAD_MAIN, minGap: MIN_GAP, maxGapStretch: Infinity };
const FRAME_PACKING: Packing = { dummy: 12, padCross: 16, padMain: 12, minGap: 40, maxGapStretch: 120 };
// A layer too crowded for the canvas is staggered into two rows along the
// main axis, its boxes interleaved so each back-row box sits behind the
// gap between two front-row boxes and its edges pass through that gap.
const STAGGER_FROM = 4;
const STAGGER_CLEARANCE = 12;
const ROW_GAP = 24;
// Where edges leave and enter a box: each end has a port of its own on its
// side, PORT_PITCH apart where the side has room. Packed closer, two lines
// keep LINE_PORT_PITCH apart and an arrowhead keeps ARROW_PORT_PITCH from
// its neighbours (its own width and a gap), so heads never stack; a box
// whose side is too short for its ports grows along that side.
const PORT_PITCH = 16;
const LINE_PORT_PITCH = 10;
export const ARROW_PORT_PITCH = ARROW_LENGTH + 3;
const PORT_INSET = 14;
const SELF_LOOP = 18;
// A run of more than this many long edges side by side through a layer,
// each within BUNDLE_REACH of the next, has its longest drawn as stubs
// (`bundledEdges`), for a few rounds; whatever the last round finds stays.
const BUNDLE_CAP = 4;
const BUNDLE_REACH = 16;
const BUNDLE_ROUNDS = 4;
// Layers are ordered from this many shuffled starts as well as the given
// order and a depth-first one, and sifted (`orderLayers`), when no more than
// THOROUGH_SEGMENTS lines join them (a forty-step pipeline laid out for a
// phone has some 140): past that it costs more than a frame's budget.
const ORDER_SHUFFLES = 4;
const THOROUGH_SEGMENTS = 160;
// An edge longer than the frame is drawn as two stubs only when it skips at
// least this many layers (a shorter one's stubs would take the room its line
// does), and only in a drawing longer than STUB_FROM frames (`chooseStubs`).
// A bundle's excess is stubbed whatever its length (`bundledEdges`).
const STUB_MIN_SPAN = 2;
const STUB_FROM = 2;
// Space between a stub's terminal and the boxes beside it in its layer.
const TERMINAL_SPACING = 16;
// How many times the edges are judged again once terminals have taken room.
const STUB_ROUNDS = 3;
// Where a terminal's names wrap, in characters: in a narrow frame read top
// down, its names take room across, so they wrap sooner.
const TERMINAL_WRAP = { approved: 22, narrow: 16 } as const;

const EPSILON = 0.5;

// --- Text ------------------------------------------------------------------

/** Words onto lines of at most `wrapAt` characters, each line as full as it goes; a word longer than that takes a line of its own. */
export function wrapGreedy(words: string[], wrapAt: number): string[] {
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

// Where each face of a node's text wraps, and the narrowest box. A drawing
// read top down in a narrow frame runs out of room across first, and its
// boxes are its width there: their text wraps narrower and to more lines.
interface NodeWrap {
  label: { wrapAt: number; maxLines: number };
  sub: { wrapAt: number; maxLines: number };
  detail: { wrapAt: number; maxLines: number };
  minWidth: number;
}
const APPROVED_WRAP: NodeWrap = { label: NODE_TEXT.label, sub: NODE_TEXT.sub, detail: NODE_TEXT.detail, minWidth: NODE_MIN_WIDTH };
const NARROW_WRAP: NodeWrap = {
  label: { wrapAt: 12, maxLines: 3 },
  sub: { wrapAt: 18, maxLines: 3 },
  detail: { wrapAt: 26, maxLines: 2 },
  minWidth: 116,
};

export function measureNode(node: DiagramNode, cornerTags: CornerTags, wrap: NodeWrap = APPROVED_WRAP): NodeText {
  const labelLines = wrapLine(node.label, wrap.label.wrapAt, wrap.label.maxLines);
  const subLines = node.sub ? wrapLine(node.sub, wrap.sub.wrapAt, wrap.sub.maxLines) : [];
  const detailLines = node.detail ? wrapLine(node.detail, wrap.detail.wrapAt, wrap.detail.maxLines) : [];

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
    ...labelLines.map((line) => line.length * NODE_TEXT.label.advance + tagRoom(cornerTags)),
    ...subLines.map((line) => line.length * NODE_TEXT.sub.advance),
    ...detailLines.map((line) => line.length * NODE_TEXT.detail.advance),
  );
  return {
    width: Math.max(wrap.minWidth, Math.ceil(textWidth + 2 * NODE_PAD_SIDE)),
    height: last + NODE_PAD_BOTTOM,
    lines,
    ruleY,
  };
}

export function wrapEdgeLabel(text: string): string[] {
  return wrapLine(text, LABEL_WRAP_AT, LABEL_MAX_LINES);
}

const labelBacking = (text: string) => labelBox(wrapEdgeLabel(text));

// --- Lit edges ---------------------------------------------------------------

/**
 * Which edges are drawn lit: those marked active, and, when exactly one
 * node is active, every edge that touches it. The renderer lights them; the
 * layout keeps lit and unlit stubs apart, so a shared stub is lit only when
 * all its edges are.
 */
export function litEdges(data: DiagramData): (edge: DiagramEdge) => boolean {
  const active = data.nodes.filter((node) => node.state === 'active').map((node) => node.id);
  const single = active.length === 1 ? active[0] : null;
  return (edge) => Boolean(edge.active || (single !== null && (edge.from === single || edge.to === single)));
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

// --- Wrapping a layer too wide for its frame --------------------------------

/** One edge of the layered graph, by the ids of what it joins: a node, or a stub's terminal. */
interface Link {
  from: string;
  to: string;
  /** Drawn against the layout's direction: its arrowhead is at `from`. */
  reversed: boolean;
}

// The room a part of a layer takes across: its boxes and the spacing
// between them, and a dummy's spacing for each edge passing through it.
function partRoom(part: string[], through: number, extentOf: (id: string) => number, packing: Packing) {
  const lanes = through > 0 ? (through + 1) * packing.dummy : 0;
  return part.reduce((sum, id) => sum + extentOf(id), 0) + NODE_SPACING * Math.max(0, part.length - 1) + lanes;
}

// Each layer's members, and how many links pass through it.
function layerMembers(ids: string[], links: Link[], layerOf: Map<string, number>) {
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
function wrapLayers(
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
function chooseStubs(
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

// --- The layered graph -----------------------------------------------------

/**
 * The open end of a stub: a label naming the far ends of the edges it
 * stands for, in the layer next to its node (`out`: after it, `in`: before
 * it), or one further when a wrapped layer leaves no room there.
 */
interface Terminal {
  text: string;
  lines: string[];
  /** Which lines are an edge's own label under the name it is on, set quieter. */
  quiet: boolean[];
  width: number;
  height: number;
  side: 'out' | 'in';
}

interface Item {
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

const isDummy = (item: Item) => item.node === null && item.terminal === null;

interface Segment {
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
interface Route {
  /** Laid out against the edge's direction: drawn from its last point to its first. */
  reversed: boolean;
  /** An edge's own label; a stub's names are on its terminal. */
  label: string | null;
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

/**
 * Moves each item of a layer to the place in it where its edges cross the
 * fewest others (sifting): the crossings it makes with each other item
 * depend only on which of the two comes first, so every place is weighed
 * in one pass. It moves only for a strict gain.
 */
function sift(layer: Item[]) {
  for (const item of [...layer]) {
    const others = layer.filter((other) => other !== item);
    const after = others.map((other) => pairCrossings(other, item));
    const before = others.map((other) => pairCrossings(item, other));
    let cost = before.reduce((sum, count) => sum + count, 0);
    let best = cost;
    let bestAt = 0;
    let current = Infinity;
    for (let at = 0; at <= others.length; at += 1) {
      if (at > 0) cost += after[at - 1] - before[at - 1];
      if (at === item.index) current = cost;
      if (cost < best) {
        best = cost;
        bestAt = at;
      }
    }
    if (best < current) {
      layer.splice(0, layer.length, ...others.slice(0, bestAt), item, ...others.slice(bestAt));
      reindex(layer);
    }
  }
}

/** Barycenter sweeps with adjacent swaps, then (when `sifting`) sifting, from the layers' present order; returns the crossings left. */
function reduceCrossings(layers: Item[][], sifting: boolean): number {
  let best = layers.map((layer) => [...layer]);
  let bestCrossings = totalCrossings(layers);
  const keep = () => {
    const crossings = totalCrossings(layers);
    if (crossings >= bestCrossings) return false;
    bestCrossings = crossings;
    best = layers.map((layer) => [...layer]);
    return true;
  };
  const restore = () =>
    best.forEach((layer, index) => {
      layers[index].splice(0, layers[index].length, ...layer);
      reindex(layers[index]);
    });
  for (let round = 0; round < 8 && bestCrossings > 0; round += 1) {
    const down = round % 2 === 0;
    if (down) {
      for (let index = 1; index < layers.length; index += 1) barycenterSort(layers[index], (item) => item.preds);
    } else {
      for (let index = layers.length - 2; index >= 0; index -= 1) barycenterSort(layers[index], (item) => item.succs);
    }
    for (const layer of layers) transpose(layer);
    keep();
  }
  // From the best order the sweeps found, sift each layer in turn, down
  // and up, while that still removes crossings.
  restore();
  for (let round = 0; round < 8 && bestCrossings > 0 && sifting; round += 1) {
    for (const layer of round % 2 === 0 ? layers : [...layers].reverse()) sift(layer);
    if (!keep()) break;
  }
  restore();
  return bestCrossings;
}

/**
 * Orders each layer to reduce crossings. Sweeps settle on the first
 * minimum they reach, so they start from several orders: the order the
 * items were given in, a depth-first walk (which keeps each chain's
 * members together), and a few shuffles drawn from a fixed seed, so the
 * result is the same every time. The order with fewest crossings is kept,
 * the earliest on a tie.
 */
function orderLayers(layers: Item[][]) {
  for (const layer of layers) reindex(layer);
  const given = layers.map((layer) => [...layer]);
  // A graph of the size agents draw is ordered thoroughly; a larger one
  // gets the sweeps alone, from the given order, within a frame's budget.
  const thorough = given.reduce((sum, layer) => sum + layer.reduce((count, item) => count + item.succs.length, 0), 0) <= THOROUGH_SEGMENTS;
  let best = reduceCrossings(layers, thorough);
  if (!thorough) return;
  let bestOrder = layers.map((layer) => [...layer]);
  const start = (order: Item[][]) => {
    order.forEach((layer, index) => {
      layers[index].splice(0, layers[index].length, ...layer);
      reindex(layers[index]);
    });
    const crossings = reduceCrossings(layers, true);
    if (crossings < best) {
      best = crossings;
      bestOrder = layers.map((layer) => [...layer]);
    }
  };
  const seen = new Map<Item, number>();
  const walk = (item: Item) => {
    if (seen.has(item)) return;
    seen.set(item, seen.size);
    for (const next of item.succs) walk(next);
  };
  for (const layer of given) for (const item of layer) if (!item.preds.length) walk(item);
  for (const layer of given) for (const item of layer) walk(item);
  if (best > 0) start(given.map((layer) => [...layer].sort((a, b) => (seen.get(a) ?? 0) - (seen.get(b) ?? 0))));
  let seed = 1;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let round = 0; round < ORDER_SHUFFLES && best > 0; round += 1) {
    start(given.map((layer) => layer.map((item) => ({ item, key: next() })).sort((a, b) => a.key - b.key).map((entry) => entry.item)));
  }
  start(bestOrder);
}

// --- Cross coordinates -----------------------------------------------------

function separation(a: Item, b: Item, stretch: number, packing: Packing) {
  if (a.node && b.node && a.staggered && a.row !== b.row) {
    // Boxes in different rows may overlap along the cross axis; what must
    // stay clear is the spread of ports about each box's centre line,
    // where its edges run through the other row.
    return Math.max(a.crossExtent / 2 + b.facingHalf, b.crossExtent / 2 + a.facingHalf) + STAGGER_CLEARANCE;
  }
  const spacing = a.node && b.node ? NODE_SPACING + stretch : isDummy(a) || isDummy(b) ? packing.dummy : TERMINAL_SPACING;
  return a.crossExtent / 2 + spacing + b.crossExtent / 2;
}

/**
 * Settles each item of a layer toward its wanted position, as far as the
 * items beside it allow: an item already placed is a wall, one not yet
 * placed is pushed aside. Dummies go first so long edges stay straight,
 * then the nodes with most edges.
 */
function settleLayer(layer: Item[], wantedOf: (item: Item) => number | null, stretch: number, packing: Packing, band?: number) {
  const sep = (index: number) => separation(layer[index], layer[index + 1], stretch, packing);
  // Laid out for a frame, a layer that fits the band across keeps inside
  // it: the band's edges are walls, as a placed neighbour is.
  const offsets = [0];
  for (let k = 0; k + 1 < layer.length; k += 1) offsets.push(offsets[k] + sep(k));
  const stack = layer.length ? layer[0].crossExtent / 2 + offsets[offsets.length - 1] + layer[layer.length - 1].crossExtent / 2 : 0;
  // (A stack the stretch filled to the band exactly is in it, rounding aside.)
  const walled = band !== undefined && layer.length > 0 && stack <= band + EPSILON;
  const wallLow = (index: number) => (walled ? -band / 2 + layer[0].crossExtent / 2 + offsets[index] : -Infinity);
  const wallHigh = (index: number) =>
    walled ? band / 2 - layer[layer.length - 1].crossExtent / 2 - (offsets[offsets.length - 1] - offsets[index]) : Infinity;
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
    const dummy = Number(isDummy(b)) - Number(isDummy(a));
    if (dummy) return dummy;
    const degree = b.preds.length + b.succs.length - (a.preds.length + a.succs.length);
    return degree || a.index - b.index;
  });
  const fixed = layer.map(() => false);
  for (const item of order) {
    const i = item.index;
    const target = wanted(item);
    if (target !== null) {
      let low = wallLow(i);
      let span = 0;
      for (let k = i - 1; k >= 0; k -= 1) {
        span += sep(k);
        if (fixed[k]) {
          low = layer[k].cross + span;
          break;
        }
      }
      let high = wallHigh(i);
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

function assignCross(layers: Item[][], usableCross: number, packing: Packing, band?: number) {
  const stretches = layers.map((layer) => {
    const real = layer.filter((item) => item.node);
    if (real.length < 2) return 0;
    const natural = real.reduce((sum, item) => sum + item.crossExtent, 0) + NODE_SPACING * (real.length - 1);
    // A sparse layer spreads to use the room across, less what the edges
    // passing through it take.
    const passing = layer.filter(isDummy).length;
    const room = usableCross - (passing > 0 ? (passing + 1) * packing.dummy : 0);
    // A stub's terminal has no row of its own, so a layer holding one is
    // never staggered (only a frame draws stubs, and it wraps a crowded
    // layer instead).
    if (real.length >= STAGGER_FROM && natural > usableCross && !layer.some((item) => item.terminal)) {
      real.forEach((item, index) => {
        item.row = index % 2 === 0 ? 0 : 1;
        // Row 0's out side and row 1's in side face the other row: their
        // lines run through it, packed as close as their ports allow.
        item.facingHalf = item.row === 0 ? endsSpan(item.outs, 'out') / 2 : endsSpan(item.ins, 'in') / 2;
      });
      for (const item of layer) item.staggered = true;
      return 0;
    }
    // The spread is shared by the gaps between neighbouring boxes, and
    // never takes the layer past the room it has when the layer fits it.
    let stack = layer.length ? (layer[0].crossExtent + layer[layer.length - 1].crossExtent) / 2 : 0;
    let pairs = 0;
    layer.forEach((item, k) => {
      if (k === 0) return;
      stack += separation(layer[k - 1], item, 0, packing);
      if (item.node && layer[k - 1].node) pairs += 1;
    });
    const spread = Math.min((room - natural) / (real.length - 1), pairs ? (usableCross - stack) / pairs : 0);
    return Math.max(0, Math.min(MAX_STRETCH, spread));
  });
  layers.forEach((layer, index) => {
    const stretch = stretches[index];
    // Stack the layer from zero, then centre the stack on zero.
    let cursor = 0;
    layer.forEach((item, k) => {
      if (k > 0) cursor += separation(layer[k - 1], item, stretch, packing);
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
    for (let index = 1; index < layers.length; index += 1) settleLayer(layers[index], towardPreds, stretches[index], packing, band);
    for (let index = layers.length - 2; index >= 0; index -= 1) settleLayer(layers[index], towardSuccs, stretches[index], packing, band);
  }
}

// --- Ports and tracks ------------------------------------------------------

/** Whether an end of a segment at a node carries the edge's arrowhead: it does where the edge truly ends. */
const arrowAt = (segment: Segment, side: 'out' | 'in') => (side === 'in' ? !segment.reversed : segment.reversed);

/** The least room ports need between neighbours, by whether either carries an arrowhead. */
const portGap = (a: boolean, b: boolean) => (a || b ? ARROW_PORT_PITCH : LINE_PORT_PITCH);

/**
 * The least span the ports of these ends need along their side, in any
 * order: each arrowhead holds ARROW_PORT_PITCH from both its neighbours.
 */
function portSpan(count: number, arrows: number): number {
  if (count < 2) return 0;
  const pairs = count - 1;
  const crowded = Math.min(pairs, 2 * arrows);
  return crowded * ARROW_PORT_PITCH + (pairs - crowded) * LINE_PORT_PITCH;
}
const endsSpan = (ends: Segment[], side: 'out' | 'in') => portSpan(ends.length, ends.filter((segment) => arrowAt(segment, side)).length);

/**
 * Gives every end on each node's side a port of its own, in the order of
 * the ends' far ends so no two cross at the box. Ports sit PORT_PITCH apart
 * where the side has room, and never closer than portGap; a side short of
 * room for that grew to hold it (`portRoom` in `arrange`). A staggered
 * box's lines through the other row pack as close as portGap allows.
 */
function assignPorts(layers: Item[][]) {
  for (const layer of layers) {
    for (const item of layer) {
      if (!item.node) continue;
      for (const side of ['out', 'in'] as const) {
        const ends = [...(side === 'out' ? item.outs : item.ins)];
        if (!ends.length) continue;
        const far = (segment: Segment) => (side === 'out' ? segment.to.cross : segment.from.cross);
        ends.sort((a, b) => far(a) - far(b) || a.edge - b.edge);
        const least = ends.slice(1).map((segment, index) => portGap(arrowAt(ends[index], side), arrowAt(segment, side)));
        const leastSpan = least.reduce((sum, gap) => sum + gap, 0);
        const room = item.crossExtent - 2 * PORT_INSET;
        const facing = item.staggered && (side === 'out' ? item.row === 0 : item.row === 1);
        let gaps = least;
        if (!facing) {
          if (least.length * PORT_PITCH <= room) {
            gaps = least.map(() => PORT_PITCH);
          } else if (room > leastSpan) {
            // Share what room there is, each gap moving toward PORT_PITCH
            // in step.
            const slack = least.reduce((sum, gap) => sum + (PORT_PITCH - gap), 0);
            gaps = least.map((gap) => gap + ((room - leastSpan) * (PORT_PITCH - gap)) / slack);
          }
        }
        const span = gaps.reduce((sum, gap) => sum + gap, 0);
        let cross = item.cross - span / 2;
        ends.forEach((segment, index) => {
          if (index > 0) cross += gaps[index - 1];
          if (side === 'out') segment.fromCross = cross;
          else segment.toCross = cross;
        });
      }
    }
  }
}

/**
 * Gives every bend in a gap a track. Two bends whose cross runs overlap
 * (or touch, other than at a shared port) take different tracks, ordered so an edge that starts nearer the far
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
  // Runs that only touch end to end still meet on one track, and read as
  // one line with a junction, unless the point they share is one port of
  // one box: branches of a trunk may part there.
  const sharePort = (a: Segment, b: Segment, at: number) =>
    (a.from === b.from && Math.abs(a.fromCross - at) < 1e-6 && Math.abs(b.fromCross - at) < 1e-6) ||
    (a.to === b.to && Math.abs(a.toCross - at) < 1e-6 && Math.abs(b.toCross - at) < 1e-6);
  const meet = (a: (typeof keyed)[number], b: (typeof keyed)[number]) => {
    if (a.low < b.high - 1e-6 && b.low < a.high - 1e-6) return true;
    if (Math.abs(a.high - b.low) < 1e-6) return !sharePort(a.segment, b.segment, a.high);
    if (Math.abs(b.high - a.low) < 1e-6) return !sharePort(a.segment, b.segment, a.low);
    return false;
  };
  let count = 0;
  keyed.forEach((entry, index) => {
    let track = 0;
    for (let other = 0; other < index; other += 1) {
      const earlier = keyed[other];
      if (meet(earlier, entry)) track = Math.max(track, earlier.track + 1);
    }
    entry.track = track;
    entry.segment.track = track;
    count = Math.max(count, track + 1);
  });
  return count;
}

// --- Bundles ---------------------------------------------------------------

/**
 * The edges to draw as stubs so that no more than BUNDLE_CAP long edges
 * run side by side through a layer: a bundle is a run of the dummies of
 * edges passing a layer with nothing between them and no more than
 * BUNDLE_REACH apart. Past the cap, lines that close together cannot be
 * told apart along their run. Of a bundle's edges the longest go first,
 * as many as it is over the cap; an edge's stubs may only stand for an
 * edge drawn whole, so a stub's own dummies never count against it.
 */
function bundledEdges(layers: Item[][], routes: Route[], routeOf: Map<DiagramEdge, Route>, packing: Packing): Set<DiagramEdge> {
  const edgeOf = new Map<Route, DiagramEdge>();
  for (const [edge, route] of routeOf) edgeOf.set(route, edge);
  const chosen = new Set<DiagramEdge>();
  const reach = Math.max(BUNDLE_REACH, packing.dummy);
  for (const layer of layers) {
    // A run's lines, each the edge it draws, or null for a stub's line.
    let run: Array<DiagramEdge | null> = [];
    const close = () => {
      if (run.length > BUNDLE_CAP) {
        const span = (edge: DiagramEdge) => routeOf.get(edge)?.segments.length ?? 0;
        const open = run.filter((edge): edge is DiagramEdge => edge !== null && !chosen.has(edge)).sort((a, b) => span(b) - span(a));
        for (const edge of open.slice(0, run.length - BUNDLE_CAP)) chosen.add(edge);
      }
      run = [];
    };
    layer.forEach((item, index) => {
      const previous = layer[index - 1];
      if (!isDummy(item) || (previous && (!isDummy(previous) || item.cross - previous.cross > reach + EPSILON))) close();
      if (isDummy(item)) run.push(edgeOf.get(routes[item.ins[0]?.edge ?? -1]) ?? null);
    });
    close();
  }
  return chosen;
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

/**
 * The room a drawing is laid out for, in user units along its main and
 * cross axes: the frame it will be read in, at the scale it will be read
 * at. Without one, the drawing is laid out for the approved canvas.
 */
export interface DiagramFrame {
  main: number;
  cross: number;
}

export function layoutDiagram(data: DiagramData, orientation: DiagramOrientation, anchorNodeId?: string, frame?: DiagramFrame): DiagramLayout {
  // Stubbing a bundle's excess moves other edges, which may bundle in turn:
  // a few rounds at most, the last one finishing whatever it finds.
  const extra = new Set<DiagramEdge>();
  for (let round = 0; ; round += 1) {
    const { layout, bundled } = arrange(data, orientation, anchorNodeId, frame, extra, round === BUNDLE_ROUNDS - 1);
    if (layout) return layout;
    for (const edge of bundled) extra.add(edge);
  }
}

/**
 * Lays a graph out. Laid out for a frame, it first settles every layer
 * across; if the long edges passing some layer then run as a bundle wider
 * than BUNDLE_CAP, it stops and returns the edges to draw as stubs as well
 * (the longest of each bundle's excess), to be laid out again with them
 * and those it was given (`extra`). Told to `finish`, it always does.
 */
function arrange(
  data: DiagramData,
  orientation: DiagramOrientation,
  anchorNodeId: string | undefined,
  frame: DiagramFrame | undefined,
  extra: Set<DiagramEdge>,
  finish: boolean,
): { layout: DiagramLayout | null; bundled: Set<DiagramEdge> } {
  const canvas = frame ?? CANVAS[orientation];
  const landscape = orientation === 'landscape';
  const point = (main: number, cross: number): Point => (landscape ? { x: main, y: cross } : { x: cross, y: main });
  // A label's extent along each axis. Text is always horizontal, so which
  // of its sides runs along the main axis depends on the orientation.
  const labelExtent = (text: string) => {
    const backing = labelBacking(text);
    return landscape ? { main: backing.width, cross: backing.height } : { main: backing.height, cross: backing.width };
  };

  // --- Nodes, layers, stubs -------------------------------------------------
  // A done or blocked node carries its state glyph in its corner, and the
  // anchored node may carry the NOTE marker there too.
  const packing = frame ? FRAME_PACKING : APPROVED_PACKING;
  const wrap = frame && !landscape && frame.cross < CANVAS.portrait.cross ? NARROW_WRAP : APPROVED_WRAP;
  const textOf = new Map(
    data.nodes.map((node) => [node.id, measureNode(node, { glyph: node.state === 'done' || node.state === 'blocked', marker: node.id === anchorNodeId }, wrap)]),
  );
  const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
  const directed = breakCycles(data.nodes, data.edges);
  const layerOf = assignLayers(data.nodes, directed);
  const usable = canvas.cross - 2 * packing.padCross;
  // A stub's terminal is the label at its open end, in the layer next to its
  // node: `-> target` past its true source, `source ->` before its true
  // target.
  const terminals = new Map<string, Terminal>();
  // A box whose side is too short for a port of its own per end grows
  // along that side; every edge has one end at each of its nodes, stub or
  // not, and an arrowhead at its true target.
  const portRoom = new Map<string, number>();
  const measurePorts = (links: Link[]) => {
    const ends = new Map<string, { out: number; outArrows: number; in: number; inArrows: number }>();
    const of = (id: string) => ends.get(id) ?? ends.set(id, { out: 0, outArrows: 0, in: 0, inArrows: 0 }).get(id)!;
    for (const link of links) {
      const from = of(link.from);
      const to = of(link.to);
      from.out += 1;
      to.in += 1;
      if (link.reversed) from.outArrows += 1;
      else to.inArrows += 1;
    }
    portRoom.clear();
    for (const [id, count] of ends) portRoom.set(id, Math.max(portSpan(count.out, count.outArrows), portSpan(count.in, count.inArrows)) + 2 * PORT_INSET);
  };
  measurePorts(directed);
  // Half the most a staggered box's ports can spread on a side (`separation`).
  const facingOf = (id: string) => Math.max(0, (portRoom.get(id) ?? 0) - 2 * PORT_INSET) / 2;
  const lit = litEdges(data);
  const extentOf = (id: string) => {
    const text = textOf.get(id);
    if (text) {
      const cross = Math.max(landscape ? text.height : text.width, portRoom.get(id) ?? 0);
      return { main: landscape ? text.width : text.height, cross };
    }
    const terminal = terminals.get(id);
    if (!terminal) return { main: 0, cross: 0 };
    return landscape ? { main: terminal.width, cross: terminal.height } : { main: terminal.height, cross: terminal.width };
  };
  const stubbed = new Set<DirectedEdge>();
  // Each stubbed edge's two terminals, by id: the one by its layout source
  // and the one by its layout target.
  const terminalsOf = new Map<DirectedEdge, { out: string; in: string }>();
  const links: Link[] = [...directed];
  if (frame) {
    // Laid out for a frame, a layer too wide for it wraps into several, and
    // an edge longer than the frame is drawn as stubs. Their terminals take
    // room in the layers beside their nodes, so those layers are wrapped
    // again with them in; that can stretch other edges past the frame, so
    // the edges are judged again, a few rounds at most.
    const nodeIds = data.nodes.map((node) => node.id);
    wrapLayers(nodeIds, links, layerOf, (id) => extentOf(id).cross, usable, packing, () => true, facingOf, () => 0);
    const wrapped = new Map(layerOf);
    const window = canvas.main - 2 * packing.padMain;
    for (const entry of directed) if (extra.has(entry.edge)) stubbed.add(entry);
    for (let round = 0; round < STUB_ROUNDS; round += 1) {
      const whole = directed.filter((entry) => !stubbed.has(entry));
      const longer = chooseStubs(whole, links, layerOf, (id) => extentOf(id).main, (text) => labelExtent(text).main, window, packing);
      if (!longer.size && (round > 0 || !stubbed.size)) break;
      for (const entry of longer) stubbed.add(entry);
      layerOf.clear();
      for (const [id, layer] of wrapped) layerOf.set(id, layer);
      terminals.clear();
      terminalsOf.clear();
      // The stubs that leave one side of a node the same way, in the same
      // colour, share one terminal listing every far end, so a node sends
      // one stub to `-> a / -> b` rather than a row of them. It stands in
      // the layer next to its node.
      const entries = new Map<string, { node: string; side: 'out' | 'in'; reversed: boolean; texts: string[]; quiet: boolean[]; named: Set<string> }>();
      const wrapAt = wrap === NARROW_WRAP ? TERMINAL_WRAP.narrow : TERMINAL_WRAP.approved;
      for (const entry of directed) {
        if (!stubbed.has(entry)) continue;
        const { edge } = entry;
        const source = nodeById.get(edge.from)?.label ?? edge.from;
        const target = nodeById.get(edge.to)?.label ?? edge.to;
        const note = edge.label ? wrapLine(edge.label, wrapAt, 2) : [];
        // By its true source a stub names the target; by its true target,
        // the source. Laid out backwards, the layout source is the target.
        const style = `${edge.semantic ?? 'paper'}/${lit(edge) ? 'lit' : ''}`;
        const ids = { out: `\u0000${entry.from}/out/${entry.reversed}/${style}`, in: `\u0000${entry.to}/in/${entry.reversed}/${style}` };
        // The arrow stays on the line with the name's first word (toward the
        // target) or its last (from the source), next to where the stub
        // meets the names. A feedback edge runs against the reading axis, so
        // read across the page its arrow is drawn the other way round:
        // `target <-` by its source, `<- source` by its target. Read down
        // the page the arrow is a mark of direction, not of the line, and
        // stays `->`.
        const back = entry.reversed && landscape;
        const first = (name: string, mark: string) => wrapLine(name, wrapAt - 3, 3).map((line, index) => (index === 0 ? `${mark} ${line}` : line));
        const last = (name: string, mark: string) => wrapLine(name, wrapAt - 3, 3).map((line, index, all) => (index === all.length - 1 ? `${line} ${mark}` : line));
        const toTarget = back ? last(target, '<-') : first(target, '->');
        const fromSource = back ? first(source, '<-') : last(source, '->');
        for (const [id, node, side, lines] of [
          [ids.out, entry.from, 'out', entry.reversed ? fromSource : toTarget],
          [ids.in, entry.to, 'in', entry.reversed ? toTarget : fromSource],
        ] as const) {
          const known = entries.get(id) ?? { node, side, reversed: entry.reversed, texts: [], quiet: [], named: new Set<string>() };
          // Two edges alike (the same far end and label) are named once.
          const key = [...lines, '', ...note].join('\n');
          if (!known.named.has(key)) {
            known.named.add(key);
            known.texts.push(...lines, ...note);
            known.quiet.push(...lines.map(() => false), ...note.map(() => true));
          }
          entries.set(id, known);
        }
        terminalsOf.set(entry, ids);
      }
      links.splice(0, links.length, ...directed.filter((entry) => !stubbed.has(entry)));
      for (const [id, entry] of entries) {
        const { width, height } = labelBox(entry.texts);
        terminals.set(id, { text: entry.texts.join(' '), lines: entry.texts, quiet: entry.quiet, width, height, side: entry.side });
        layerOf.set(id, (layerOf.get(entry.node) ?? 0) + (entry.side === 'out' ? 1 : -1));
        links.push(entry.side === 'out' ? { from: entry.node, to: id, reversed: entry.reversed } : { from: id, to: entry.node, reversed: entry.reversed });
      }
      measurePorts(links);
      // A terminal keeps beside its node when either of their layers wraps:
      // it goes in the part of its layer nearest the node, and the node in
      // the part of its own nearest the terminal.
      const pins = new Map<string, number>();
      const sides = new Map<string, Set<'out' | 'in'>>();
      for (const [id, entry] of entries) {
        // Terminals at the very ends of a layer, so that nodes held to an
        // end do not crowd them out of the part next to their own nodes.
        pins.set(id, entry.side === 'out' ? -2 : 2);
        sides.set(entry.node, (sides.get(entry.node) ?? new Set()).add(entry.side));
      }
      for (const [node, has] of sides) pins.set(node, has.size === 2 ? 0 : has.has('out') ? 1 : -1);
      const members = [...nodeIds, ...terminals.keys()];
      wrapLayers(members, links, layerOf, (id) => extentOf(id).cross, usable, packing, (id) => !terminals.has(id), facingOf, (id) => pins.get(id) ?? 0);
      // A node held to the far end of its layer may still have been wrapped
      // into an earlier part than its terminal's neighbour; its terminal
      // then moves next to it where that layer has room across.
      for (const [id, entry] of entries) {
        const near = (layerOf.get(entry.node) ?? 0) + (entry.side === 'out' ? 1 : -1);
        if (layerOf.get(id) === near || near < 0) continue;
        const { members: parts, passing } = layerMembers(members, links, layerOf);
        if (near >= parts.length) continue;
        if (partRoom([...parts[near], id], passing[near], (member) => extentOf(member).cross, packing) <= usable) layerOf.set(id, near);
      }
      // A layer the moves left empty closes up.
      const used = [...new Set(layerOf.values())].sort((a, b) => a - b);
      const compact = new Map(used.map((layer, index) => [layer, index]));
      for (const [id, layer] of layerOf) layerOf.set(id, compact.get(layer) ?? 0);
    }
  }

  const layerCount = data.nodes.length ? Math.max(...layerOf.values()) + 1 : 0;
  const layers: Item[][] = Array.from({ length: layerCount }, () => []);
  const itemOf = new Map<string, Item>();
  const makeItem = (layer: number, id: string | null): Item => {
    const node = id === null ? null : (nodeById.get(id) ?? null);
    const extent = id === null ? { main: 0, cross: 0 } : extentOf(id);
    const item: Item = {
      layer,
      index: layers[layer].length,
      row: 0,
      staggered: false,
      node,
      terminal: id === null ? null : (terminals.get(id) ?? null),
      text: id === null ? null : (textOf.get(id) ?? null),
      mainExtent: extent.main,
      crossExtent: extent.cross,
      facingHalf: 0,
      main: 0,
      cross: 0,
      preds: [],
      succs: [],
      outs: [],
      ins: [],
    };
    layers[layer].push(item);
    if (id !== null) itemOf.set(id, item);
    return item;
  };
  for (const node of data.nodes) makeItem(layerOf.get(node.id) ?? 0, node.id);
  for (const id of terminals.keys()) makeItem(layerOf.get(id) ?? 0, id);

  const routes: Route[] = [];
  const segments: Segment[] = [];
  const addRoute = (fromId: string, toId: string, reversed: boolean, label: string | null): Route | null => {
    const from = itemOf.get(fromId);
    const to = itemOf.get(toId);
    if (!from || !to) return null;
    const route: Route = { reversed, label, segments: [] };
    const routeIndex = routes.length;
    routes.push(route);
    let previous = from;
    for (let layer = from.layer + 1; layer <= to.layer; layer += 1) {
      const next = layer === to.layer ? to : makeItem(layer, null);
      const segment: Segment = { edge: routeIndex, from: previous, to: next, fromCross: 0, toCross: 0, track: null, reversed };
      previous.succs.push(next);
      next.preds.push(previous);
      previous.outs.push(segment);
      next.ins.push(segment);
      route.segments.push(segment);
      segments.push(segment);
      previous = next;
    }
    return route;
  };
  // Every edge drawn whole has a route; so does every terminal, from the
  // node it stands by (or to it).
  const directedByEdge = new Map(directed.map((entry) => [entry.edge, entry]));
  const routeOf = new Map<DiagramEdge, Route>();
  for (const edge of data.edges) {
    const entry = directedByEdge.get(edge);
    if (!entry || stubbed.has(entry)) continue;
    const route = addRoute(entry.from, entry.to, entry.reversed, edge.label ?? null);
    if (route) routeOf.set(edge, route);
  }
  const stubRouteOf = new Map<string, Route>();
  for (const id of terminals.keys()) {
    const link = links.find((candidate) => candidate.from === id || candidate.to === id);
    const route = link ? addRoute(link.from, link.to, link.reversed, null) : null;
    if (route) stubRouteOf.set(id, route);
  }

  // --- Order and settle each layer -----------------------------------------
  orderLayers(layers);
  const band = frame ? usable : null;
  assignCross(layers, usable, packing, band ?? undefined);
  if (frame && !finish) {
    const bundled = bundledEdges(layers, routes, routeOf, packing);
    if (bundled.size) return { layout: null, bundled };
  }
  // A dummy that settled a hair off the line of its segment snaps onto it:
  // a route is straight or it bends, never a sliver of diagonal.
  for (const segment of segments) {
    if (Math.abs(segment.from.cross - segment.to.cross) > EPSILON) continue;
    if (isDummy(segment.to)) segment.to.cross = segment.from.cross;
    else if (isDummy(segment.from)) segment.from.cross = segment.to.cross;
  }
  for (const segment of segments) {
    segment.fromCross = segment.from.cross;
    segment.toCross = segment.to.cross;
  }
  assignPorts(layers);

  // --- Gaps: tracks and labels, relative to each gap's centre -------------
  const gapIndexOf = (route: Route) => route.segments[0].from.layer + Math.floor((route.segments.length - 1) / 2);
  const gaps = Array.from({ length: Math.max(0, layerCount - 1) }, (_, gap) => {
    const own = segments.filter((segment) => segment.from.layer === gap);
    // A gap is measured from its centre, where its tracks are centred, out
    // to each of its ends: each side holds what reaches that way.
    return { tracks: assignTracks(own), before: packing.minGap / 2, after: packing.minGap / 2, centre: 0 };
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
    const text = route.label;
    if (!text) return;
    const gap = gapIndexOf(route);
    const mid = route.segments[gap - route.segments[0].from.layer];
    const extent = labelExtent(text);
    // Laid out for a frame, a label at the band's edge slides inward, as
    // far as keeps its line passing under it, rather than taking the
    // drawing past the frame across.
    const reach = Math.max(0, extent.cross / 2 - LABEL_HOLD);
    const inBand = (cross: number) => {
      if (band === null) return cross;
      const banded = Math.min(Math.max(cross, -band / 2 + extent.cross / 2), band / 2 - extent.cross / 2);
      return Math.min(Math.max(banded, cross - reach), cross + reach);
    };
    const place = (mainOffset: number, cross: number): PlacedLabel => ({ text, gap, mainOffset, cross: inBand(cross), extent });
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
  const natural = bands.reduce((sum, band) => sum + band, 0) + gaps.reduce((sum, gap) => sum + gap.before + gap.after, 0) + 2 * packing.padMain;
  // A short drawing spreads its gaps to use the canvas; laid out for a
  // frame, only so far, and the rest is left either side of it.
  const stretch = gaps.length ? Math.min(packing.maxGapStretch, Math.max(0, (canvas.main - natural) / gaps.length)) : 0;
  let cursor = packing.padMain + (frame ? Math.max(0, canvas.main - natural - stretch * gaps.length) / 2 : 0);
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
  const mainSize = Math.max(canvas.main, layerCount ? cursor + packing.padMain : canvas.main);
  const trackMain = (segment: Segment) => gaps[segment.from.layer].centre + trackOffset(segment);

  // --- Routes ----------------------------------------------------------------
  // A line meets a box (a node, or a stub's terminal) at its outline and
  // passes a dummy's place straight through.
  const laidOut = routes.map((route) => {
    const points: MainCross[] = [];
    route.segments.forEach((segment, index) => {
      const exit = isDummy(segment.from) ? segment.from.main : segment.from.main + segment.from.mainExtent / 2;
      const entrance = isDummy(segment.to) ? segment.to.main : segment.to.main - segment.to.mainExtent / 2;
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
  // The estimate a stub was chosen by can fall short of the drawn run (the
  // gaps grow with their labels): an edge drawn whole that still runs
  // longer than the frame is drawn as stubs on the next round.
  if (frame && !finish && (cursor + packing.padMain) > STUB_FROM * (canvas.main - 2 * packing.padMain)) {
    const longer = new Set<DiagramEdge>();
    const pointsOf = new Map(laidOut.map((entry) => [entry.route, entry.points]));
    for (const [edge, route] of routeOf) {
      const drawn = (pointsOf.get(route) ?? []).map(([main]) => main);
      if (Math.max(...drawn) - Math.min(...drawn) > canvas.main - 2 * packing.padMain && route.segments.length >= STUB_MIN_SPAN) longer.add(edge);
    }
    if (longer.size) return { layout: null, bundled: longer };
  }

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
  for (const layer of layers) for (const item of layer) if (!isDummy(item)) include(item.cross, item.crossExtent);
  for (const { points, label } of laidOut) {
    for (const [, cross] of points) include(cross);
    if (label) include(label.cross, labelExtent(label.text).cross);
  }
  for (const loop of loops) for (const [, cross] of loop.points) include(cross);
  if (!Number.isFinite(crossMin)) {
    crossMin = 0;
    crossMax = 0;
  }
  const crossSize = Math.max(canvas.cross, crossMax - crossMin + 2 * packing.padCross);
  const crossShift = (crossSize - (crossMax - crossMin)) / 2 - crossMin;
  const place = (main: number, cross: number) => point(main, cross + crossShift);

  const width = landscape ? mainSize : crossSize;
  const height = landscape ? crossSize : mainSize;

  // An item's box, from its centre and extents.
  const boxOf = (item: Item): Box => {
    const centre = place(item.main, item.cross);
    const boxWidth = landscape ? item.mainExtent : item.crossExtent;
    const boxHeight = landscape ? item.crossExtent : item.mainExtent;
    return { x: centre.x - boxWidth / 2, y: centre.y - boxHeight / 2, width: boxWidth, height: boxHeight };
  };
  const nodes: LaidOutNode[] = data.nodes.flatMap((node) => {
    const item = itemOf.get(node.id);
    if (!item?.text) return [];
    return [{ node, layer: item.layer, box: boxOf(item), lines: item.text.lines, ruleY: item.text.ruleY }];
  });

  const laidOutByRoute = new Map<Route, { points: Point[]; label: EdgeLabel | null }>();
  for (const { route, points, label } of laidOut) {
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
    // A route laid out backwards is drawn from its last point to its first.
    const placed = points.map(([main, cross]) => place(main, cross));
    laidOutByRoute.set(route, { points: route.reversed ? placed.reverse() : placed, label: edgeLabel });
  }
  // A stub runs in its edges' own direction: out from a node to the
  // terminal naming targets, in from the terminal naming sources to a node.
  // Its names line up on the side its line meets.
  const stubs = new Map<string, EdgeStub>();
  for (const [id, route] of stubRouteOf) {
    const item = itemOf.get(id);
    if (!item?.terminal) continue;
    const box = boxOf(item);
    const align = !landscape ? 'middle' : item.terminal.side === 'out' ? 'start' : 'end';
    const label = { text: item.terminal.text, lines: item.terminal.lines, x: box.x + box.width / 2, y: box.y + box.height / 2, box };
    stubs.set(id, { points: laidOutByRoute.get(route)?.points ?? [], label, align, quiet: item.terminal.quiet });
  }
  const laidOutByEdge = new Map<DiagramEdge, LaidOutEdge>();
  for (const [edge, route] of routeOf) {
    const drawn = laidOutByRoute.get(route);
    laidOutByEdge.set(edge, { edge, points: drawn?.points ?? [], label: drawn?.label ?? null, reversed: route.reversed, stubs: null });
  }
  for (const [entry, ids] of terminalsOf) {
    const out = stubs.get(ids.out);
    const into = stubs.get(ids.in);
    if (!out || !into) continue;
    laidOutByEdge.set(entry.edge, { edge: entry.edge, points: [], label: null, reversed: entry.reversed, stubs: entry.reversed ? { from: into, to: out } : { from: out, to: into } });
  }
  for (const loop of loops) {
    laidOutByEdge.set(loop.edge, { edge: loop.edge, points: loop.points.map(([main, cross]) => place(main, cross)), label: null, reversed: false, stubs: null });
  }
  const edges = data.edges.flatMap((edge) => laidOutByEdge.get(edge) ?? []);

  const callout = anchorNodeId ? placeCallout(nodes, edges, anchorNodeId, width, height, orientation) : null;

  return { layout: { width, height, nodes, edges, callout }, bundled: new Set() };
}

// --- Reading the drawing in its viewport ------------------------------------

// The faces a graph sets its text in (.diagram-node-label 15, -sub 9 and
// .diagram-edge-label 11 units): the drawing is never shown so small that
// one of them drops below the page's type floors. A node's detail line
// (7 units, at a quarter of the paper's strength) is a tertiary note under
// the sub; it is let fall below the floor rather than hold every graph to
// its own size.
export const GRAPH_MIN_SCALE = readableScale([
  { size: 15, floor: 'tech' },
  { size: 9, floor: 'micro' },
  { size: 11, floor: 'tech' },
]);
// The stage's own direction (left to right on a wide viewport, top down on
// a tall one) is kept unless the other asks for this much less scrolling.
const FLOW_SWITCH = 1.25;
// A drawing read by scrolling both ways is hunted for in two dimensions; it
// is kept only if it asks for this much less scrolling than one that
// scrolls one way.
const BOTH_WAYS = 2;

export interface DiagramView {
  orientation: DiagramOrientation;
  layout: DiagramLayout;
  fit: DrawingFit;
}

/** The frame, in user units, a viewport offers a drawing read at the readable minimum. */
export function frameFor(orientation: DiagramOrientation, viewport: Viewport): DiagramFrame {
  const width = viewport.width / GRAPH_MIN_SCALE;
  const height = viewport.height / GRAPH_MIN_SCALE;
  const allowance = viewport.scrollbar / GRAPH_MIN_SCALE;
  return orientation === 'landscape' ? { main: width, cross: height - allowance } : { main: height, cross: width - allowance };
}

/**
 * Lays a graph out for a frame. Edge labels may reach past the band its
 * boxes and lines keep to; when they take the drawing past the frame
 * across, the band narrows by that much and the layout runs again, a few
 * times at most. The narrowest try is kept.
 */
function layoutForFrame(data: DiagramData, orientation: DiagramOrientation, anchorNodeId: string | undefined, frame: DiagramFrame): DiagramLayout {
  const across = (layout: DiagramLayout) => (orientation === 'landscape' ? layout.height : layout.width);
  let band = frame;
  let layout = layoutDiagram(data, orientation, anchorNodeId, band);
  let best = layout;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const excess = across(layout) - frame.cross;
    if (excess <= 0.5 || band.cross - excess < frame.cross / 2) break;
    band = { main: frame.main, cross: band.cross - excess - CLEARANCE };
    layout = layoutDiagram(data, orientation, anchorNodeId, band);
    if (across(layout) < across(best)) best = layout;
  }
  return best;
}

// Frames are laid out for the viewport rounded down to this many pixels,
// so a resize recomposes the drawing at most once a step, not on every
// pixel; the fit still uses the viewport's own size.
const FRAME_STEP = 16;

/**
 * How a graph is shown in a viewport (CSS pixels). A drawing laid out for
 * the approved canvas that fits at the readable minimum is shown so. One
 * that does not is laid out again for the viewport itself, once in each
 * direction, its wide layers wrapped to the frame across; of those and the
 * approved drawing, the one asking for the least scrolling at the readable
 * minimum is kept, the stage's own direction preferred. `layouts` may carry
 * layouts of this same graph and anchor from an earlier call, keyed by what
 * they were laid out for; it is filled as they are made.
 */
export function viewDiagram(data: DiagramData, viewport: Viewport, anchorNodeId?: string, layouts = new Map<string, DiagramLayout>()): DiagramView {
  const remembered = (key: string, make: () => DiagramLayout) => {
    const known = layouts.get(key);
    if (known) return known;
    const made = make();
    // A long resize leaves a layout per step it passed; only the last few matter.
    if (layouts.size >= 32) layouts.clear();
    layouts.set(key, made);
    return made;
  };
  const preferred: DiagramOrientation = drawingOrientation(viewport);
  const approved = remembered(`approved/${preferred}`, () => layoutDiagram(data, preferred, anchorNodeId));
  const fit = fitDrawing(approved, viewport, GRAPH_MIN_SCALE);
  if (!fit.scrollX && !fit.scrollY) return { orientation: preferred, layout: approved, fit };
  const stepped: Viewport = {
    width: Math.max(FRAME_STEP, Math.floor(viewport.width / FRAME_STEP) * FRAME_STEP),
    height: Math.max(FRAME_STEP, Math.floor(viewport.height / FRAME_STEP) * FRAME_STEP),
    scrollbar: viewport.scrollbar,
  };
  const cost = (fitted: DrawingFit) => scrollCost(fitted, viewport) * (fitted.scrollX && fitted.scrollY ? BOTH_WAYS : 1);
  const views = [
    { orientation: preferred, layout: approved, fit, cost: cost(fit) },
    ...(['landscape', 'portrait'] as const).map((orientation) => {
      const layout = remembered(`frame/${orientation}/${stepped.width}x${stepped.height}/${stepped.scrollbar}`, () =>
        layoutForFrame(data, orientation, anchorNodeId, frameFor(orientation, stepped)),
      );
      const fitted = fitDrawing(layout, viewport, GRAPH_MIN_SCALE);
      return { orientation, layout, fit: fitted, cost: cost(fitted) * (orientation === preferred ? 1 : FLOW_SWITCH) };
    }),
  ];
  const [best] = views.sort((a, b) => a.cost - b.cost);
  return { orientation: best.orientation, layout: best.layout, fit: best.fit };
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
      (e) =>
        (e.label && boxesOverlap(cand.box, e.label.box, 8)) ||
        (e.stubs && (boxesOverlap(cand.box, e.stubs.from.label.box, 8) || boxesOverlap(cand.box, e.stubs.to.label.box, 8))),
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
