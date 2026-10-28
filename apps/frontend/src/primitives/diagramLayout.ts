// Diagram geometry: which layer each node sits in, where it goes, how each
// edge is routed, and where its label sits. Pure, so the rules below can be
// checked without a browser.
//
// The layout is layered (Sugiyama-style) along a main axis (x in landscape,
// y in portrait) and spread along the cross axis:
// 1. Cycles are broken by reversing the back edges of a depth-first walk.
//    A reversed edge is laid out the other way round but drawn toward its
//    true target, so a feedback loop reads as a loop (diagram/cycles.ts).
// 2. Each node takes the longest path from a source as its layer; a node
//    whose edges would get shorter is then pulled toward its successors (diagram/layers.ts).
// 3. An edge that spans more than one layer is routed through a dummy in
//    each layer it crosses, so it threads the gaps between that layer's
//    nodes and never passes through one (the model is diagram/graph.ts).
// 4. Barycenter sweeps, adjacent swaps and sifting order each layer to
//    reduce crossings, from several starting orders (`orderLayers`, diagram/order.ts).
// 5. Each node's box is sized from its text (a monospace estimate, the same
//    way edge labels are measured, diagram/node.ts) and grows along a side too short for a
//    port of its own per edge end; a layer stacks its boxes along the cross
//    axis, grows with them, and each node then settles toward its
//    neighbours as far as the ones beside it allow (diagram/place.ts).
// 6. Routes are axis-aligned and bend in the gap between layers; bends that
//    would otherwise be ambiguous take their own track, and the gap grows to
//    hold its tracks and its labels. A label sits on its own route in the
//    gap, clear of the other labels and of the arrowheads at the gap's
//    ends, and clear of the other edges' lines where the gap leaves a spot
//    (otherwise on the spot that hides fewest); ports, tracks and bundles are diagram/route.ts.
// The drawing grows when the approved canvas is too small rather than
// letting anything overlap. Shown in a viewport (`viewDiagram`), a drawing
// too large to read whole there is laid out again for a frame of the
// viewport's size and scrolls (drawingFit.ts). Laid out for a frame, an
// edge longer than the frame, or one of too many running side by side, is
// drawn as a stub pair naming its far ends (`chooseStubs`, `bundledEdges`).

import type { DiagramData, DiagramEdge, DiagramNode } from '../controller/types';
import type { Box, Point } from './geometry';
import type { NodeLine } from './diagram/node';
import { APPROVED_WRAP, measureNode, NARROW_WRAP, wrapEdgeLabel, wrapLine } from './diagram/node';
import { LABEL_BACKING, drawingOrientation, labelBox } from './drawingKit';
import type { Packing } from './diagram/shared';
import { ARROW_ROOM, CLEARANCE, EPSILON, PORT_INSET, STUB_FROM, STUB_MIN_SPAN, TRACK_PITCH } from './diagram/shared';
import type { DirectedEdge } from './diagram/cycles';
import { breakCycles } from './diagram/cycles';
import type { Link } from './diagram/layers';
import { assignLayers, chooseStubs, layerMembers, partRoom, wrapLayers } from './diagram/layers';
import type { Item, Route, Segment, Terminal } from './diagram/graph';
import { isDummy } from './diagram/graph';
import { assignPorts, assignTracks, bundledEdges, portSpan } from './diagram/route';
import { orderLayers } from './diagram/order';
import { assignCross } from './diagram/place';
import type { DrawingFit, Viewport } from './drawingFit';
import { fitDrawing, readableScale, scrollCost } from './drawingFit';

// What the renderer and the tests read of the stages, by the one name the page uses.
export { ARROW_LENGTH } from './diagram/shared';
export { NODE_TEXT, cornerTagBoxes, measureNode, nodeFramePath, wrapEdgeLabel } from './diagram/node';

export type DiagramOrientation = 'landscape' | 'portrait';

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

// A long edge label wraps to two lines so it costs its gap less room.
/** Where a label's text starts inside its backing, for text lined up on one side. */
export const LABEL_INSET = LABEL_BACKING;
const LINE_CLEARANCE = 2;
// A label moved off the middle of its line keeps the line this far inside
// its backing's edge.
const LABEL_HOLD = 10;
// How many spots a label tries on each run before settling.
const LABEL_STOPS = 24;
// The narrowest gap between layers, labelled or not.
const MIN_GAP = 48;
const DUMMY_SPACING = 22;
const APPROVED_PACKING: Packing = { dummy: DUMMY_SPACING, padCross: PAD_CROSS, padMain: PAD_MAIN, minGap: MIN_GAP, maxGapStretch: Infinity };
const FRAME_PACKING: Packing = { dummy: 12, padCross: 16, padMain: 12, minGap: 40, maxGapStretch: 120 };
const ROW_GAP = 24;
const SELF_LOOP = 18;
const BUNDLE_ROUNDS = 4;
// How many times the edges are judged again once terminals have taken room.
const STUB_ROUNDS = 3;
// Where a terminal's names wrap, in characters: in a narrow frame read top
// down, its names take room across, so they wrap sooner.
const TERMINAL_WRAP = { approved: 22, narrow: 16 } as const;

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

interface DiagramView {
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

function placeCallout(
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
