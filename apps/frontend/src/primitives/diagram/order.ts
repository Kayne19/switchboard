// Stage 4 of the diagram layout: reducing crossings by barycenter sweeps, adjacent swaps and sifting, to the order of each layer.
import type { Item } from './graph';
import { meanOf } from './graph';

// Layers are ordered from this many shuffled starts as well as the given
// order and a depth-first one, and sifted (`orderLayers`), when no more than
// THOROUGH_SEGMENTS lines join them (a forty-step pipeline laid out for a
// phone has some 140): past that it costs more than a frame's budget.
const ORDER_SHUFFLES = 4;
const THOROUGH_SEGMENTS = 160;

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
export function orderLayers(layers: Item[][]) {
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
