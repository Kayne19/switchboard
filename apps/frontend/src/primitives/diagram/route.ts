// Stage 6 of the diagram layout: ports, bend tracks and bundles.
import type { Packing } from './shared';
import { ARROW_LENGTH, EPSILON, PORT_INSET } from './shared';
import type { Item, Route, Segment } from './graph';
import { isDummy } from './graph';
import type { DiagramEdge } from '../../controller/types';

// Where edges leave and enter a box: each end has a port of its own on its
// side, PORT_PITCH apart where the side has room. Packed closer, two lines
// keep LINE_PORT_PITCH apart and an arrowhead keeps ARROW_PORT_PITCH from
// its neighbours (its own width and a gap), so heads never stack; a box
// whose side is too short for its ports grows along that side.
const PORT_PITCH = 16;
const LINE_PORT_PITCH = 10;
const ARROW_PORT_PITCH = ARROW_LENGTH + 3;
// A run of more than this many long edges side by side through a layer,
// each within BUNDLE_REACH of the next, has its longest drawn as stubs
// (`bundledEdges`), for a few rounds; whatever the last round finds stays.
const BUNDLE_CAP = 4;
const BUNDLE_REACH = 16;

// --- Ports and tracks ------------------------------------------------------

/** Whether an end of a segment at a node carries the edge's arrowhead: it does where the edge truly ends. */
const arrowAt = (segment: Segment, side: 'out' | 'in') => (side === 'in' ? !segment.reversed : segment.reversed);

/** The least room ports need between neighbours, by whether either carries an arrowhead. */
const portGap = (a: boolean, b: boolean) => (a || b ? ARROW_PORT_PITCH : LINE_PORT_PITCH);

/**
 * The least span the ports of these ends need along their side, in any
 * order: each arrowhead holds ARROW_PORT_PITCH from both its neighbours.
 */
export function portSpan(count: number, arrows: number): number {
  if (count < 2) return 0;
  const pairs = count - 1;
  const crowded = Math.min(pairs, 2 * arrows);
  return crowded * ARROW_PORT_PITCH + (pairs - crowded) * LINE_PORT_PITCH;
}
export const endsSpan = (ends: Segment[], side: 'out' | 'in') => portSpan(ends.length, ends.filter((segment) => arrowAt(segment, side)).length);

/**
 * Gives every end on each node's side a port of its own, in the order of
 * the ends' far ends so no two cross at the box. Ports sit PORT_PITCH apart
 * where the side has room, and never closer than portGap; a side short of
 * room for that grew to hold it (`portRoom` in `arrange`). A staggered
 * box's lines through the other row pack as close as portGap allows.
 */
export function assignPorts(layers: Item[][]) {
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
export function assignTracks(segments: Segment[]): number {
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
export function bundledEdges(layers: Item[][], routes: Route[], routeOf: Map<DiagramEdge, Route>, packing: Packing): Set<DiagramEdge> {
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
