// Stage 5 of the diagram layout: the cross-axis coordinates of each layer's boxes.
import type { Item } from './graph';
import { isDummy, meanOf } from './graph';
import type { Packing } from './shared';
import { EPSILON, NODE_SPACING, STAGGER_CLEARANCE, STAGGER_FROM } from './shared';
import { endsSpan } from './route';

const MAX_STRETCH = 72;
// Space between a stub's terminal and the boxes beside it in its layer.
const TERMINAL_SPACING = 16;

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

export function assignCross(layers: Item[][], usableCross: number, packing: Packing, band?: number) {
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
