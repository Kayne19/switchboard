// How a drawing that scrolls tells its reader where they are
// (docs/visual-channel.md, "Diagrams that outgrow the frame"). Pure, in the
// CSS pixels of the scroll content, so the rules can be checked without a
// browser; DrawingViewport draws what they decide.
//
// - It rests only where the edge it is read from cuts no part: between two
//   layers of a graph, between two messages of a sequence (`restStops`),
//   and opens on its lead at such a place (`leadStop`).
// - Each edge it continues past carries a rail: how many parts lie that
//   way, and a fade over whatever the edge still cuts (`readRim`).
// - A line that leaves the view names the part at its far end, on the
//   rail where it leaves (`findExits`, `placeExits`).
// - A map of the whole drawing, the view boxed on it, stands in the corner
//   it covers least of (`mapSize`, `mapCorner`).

export interface Point {
  x: number;
  y: number;
}

/** A region of a drawing, in its user units. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What a scrolling drawing's viewport needs to know about it, in its user
 * units, to say where its reader is.
 */
export interface DrawingMap {
  /** What a reader counts past each edge, and what a view at rest keeps whole at the edge it is read from: a graph's nodes, a sequence's messages. */
  parts: Array<{ box: Region; label: string }>;
  /** What one part, and several, are called in those counts. */
  noun: { one: string; many: string };
  /** Regions a view at rest does not cut either, where it can help it, and whose cut it fades, but does not count: a graph's edge labels. */
  marks: Region[];
  /** Lines from one part to another (a graph's edges, by index into `parts`): where one leaves the view, the rim names the part at its far end. */
  links: Array<{ points: Point[]; from: number; to: number; tone: string }>;
  /** The map's sketch of the drawing. */
  sketch: { boxes: Array<{ box: Region; tone: string }>; lines: Array<{ points: Point[]; tone: string }> };
}

export type Side = 'left' | 'right' | 'top' | 'bottom';
export const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom'];

/** Where the drawing sits in the scroll content: its scale, and the margin that centres it across an axis it does not fill. */
export interface Placement {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** A span of the content along one axis, CSS pixels. */
export type Span = readonly [number, number];

/** The part of the content in view, CSS pixels: the scroller's box at its scroll position, less what a pinned band covers at its top. */
export interface View {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EPSILON = 0.5;

// Each edge a drawing continues past carries a rail this deep: a dark strip
// on the rim that holds the edge's count and the names of the lines that
// leave there. Text on a rail runs along it (turned on the left and right
// rails), so a rail costs the view no more than a line of small type. What
// lies under a rail is as good as past it.
export const RAIL = 18;

/** A region of the drawing in content pixels. */
export function placed(box: Region, place: Placement): View {
  return {
    left: place.offsetX + box.x * place.scale,
    top: place.offsetY + box.y * place.scale,
    right: place.offsetX + (box.x + box.width) * place.scale,
    bottom: place.offsetY + (box.y + box.height) * place.scale,
  };
}

// ---------------------------------------------------------------------------
// Resting

// At rest the first whole part stands this far inside the edge it is read
// from: clear of that edge's rail, with a little room. A narrower gap puts
// the edge where the part before it ends, or, narrower still, leaves that
// part's last few pixels under the rail.
export const REST_PAD = RAIL + 10;
const REST_ROOM = 6;
// Two places to rest closer than this are one.
const STOP_MERGE = 8;

/**
 * The scroll positions a drawing may rest at along one axis: where the
 * edge it is read from (the left, or the top under `inset` pixels of
 * pinned band) falls in a gap between parts, so no part there is cut or
 * under the rail, and, where the gap allows, no `soft` span (a label in
 * the gap) either; and the axis's two ends. `spans` are the parts along
 * the axis, `length` the content's extent, `view` the viewport's.
 */
export function restStops(spans: readonly Span[], length: number, view: number, inset = 0, soft: readonly Span[] = []): number[] {
  const max = length - view;
  if (max <= EPSILON) return [0];
  const candidates = [0, max];
  const between = gaps(spans);
  for (const [gapStart, gapEnd] of between) {
    const least = Math.min(gapStart, gapEnd - RAIL - REST_ROOM) - RAIL;
    let rim = Math.max(gapEnd - REST_PAD, Math.min(gapStart, gapEnd - RAIL - REST_ROOM));
    // A label the rail would cover or cut is kept whole in view, when the
    // gap leaves room before it.
    for (let tries = 0; tries < soft.length; tries += 1) {
      const clear = rim + RAIL;
      const cutting = soft.find(([start, end]) => start < clear - EPSILON && end > clear + EPSILON);
      if (!cutting || cutting[0] - RAIL - REST_ROOM < least) break;
      rim = cutting[0] - RAIL - REST_ROOM;
    }
    const stop = rim - inset;
    if (stop > EPSILON && stop < max - EPSILON) candidates.push(stop);
  }
  const clean: number[] = [];
  for (const stop of candidates.map(Math.round).sort((a, b) => a - b)) {
    const last = clean[clean.length - 1];
    if (last === undefined || stop - last >= STOP_MERGE) clean.push(stop);
    else if (stop === Math.round(max)) clean[clean.length - 1] = stop;
  }
  // Two stops further apart than a view leave a stretch the reader could
  // not stop along: it gets stops of its own, at most STRETCH of a view
  // apart, each where its edge falls in a gap if one is near enough, and
  // only where none is, on a part.
  const free = between.map(([gapStart, gapEnd]): Span => [gapStart - RAIL - inset, gapEnd - RAIL - REST_ROOM - inset]);
  const stops: number[] = [];
  clean.forEach((stop, index) => {
    stops.push(stop);
    const next = clean[index + 1];
    if (next === undefined || view <= 0 || next - stop <= view) return;
    let at = stop;
    while (next - at > view * STRETCH + STOP_MERGE) {
      const reach = at + view * STRETCH;
      const inGap = free
        .map(([low, high]): Span => [Math.max(low, at + STOP_MERGE), Math.min(high, reach)])
        .filter(([low, high]) => high >= low)
        .map(([, high]) => high);
      at = Math.round(inGap.length > 0 ? Math.max(...inGap) : reach);
      stops.push(at);
    }
  });
  return stops;
}
// How far apart the stops along a stretch stand, at most, in views.
const STRETCH = 0.6;

// The gaps between parts along an axis: where no part is.
function gaps(spans: readonly Span[]): Array<[number, number]> {
  const sorted = [...spans].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const blocks: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && start <= last[1] + EPSILON) last[1] = Math.max(last[1], end);
    else blocks.push([start, end]);
  }
  return blocks.slice(1).map((block, index) => [blocks[index][1], block[0]]);
}

/** The stop nearest `position`. */
function nearestStop(stops: readonly number[], position: number): number {
  return stops.reduce((best, stop) => (Math.abs(stop - position) < Math.abs(best - position) ? stop : best), stops[0] ?? 0);
}

/**
 * Where a drawing opens along one axis to show its lead (`lead`, a span of
 * the content): at a stop that shows the lead whole and clear of the rails,
 * one whose edge cuts no part (of `spans`) before one that does, and of
 * those the nearest to centring the lead; when no stop shows it whole, at
 * the stop nearest centring it.
 */
export function leadStop(stops: readonly number[], lead: Span, view: number, inset = 0, spans: readonly Span[] = []): number {
  const target = (lead[0] + lead[1]) / 2 - (inset + view) / 2;
  const last = stops[stops.length - 1];
  const whole = stops.filter(
    (stop) => lead[0] >= stop + inset + (stop > 0 ? RAIL : 0) - EPSILON && lead[1] <= stop + view - (stop < last ? RAIL : 0) + EPSILON,
  );
  const clean = whole.filter((stop) => stop === 0 || !spans.some(([start, end]) => start < stop + inset + RAIL - EPSILON && end > stop + inset + EPSILON));
  return nearestStop(clean.length > 0 ? clean : whole.length > 0 ? whole : stops, target);
}

// Moved less than this from where it rested, a drawing returns there.
const NUDGE = 16;

/**
 * Where a drawing settles once free input (a wheel, a drag) pauses at
 * `position`, having started from `from`: at the nearest stop, unless that
 * is where it started (or behind it) though the input moved it on, in
 * which case at the next stop that way.
 */
export function settleStop(stops: readonly number[], from: number, position: number): number {
  const nearest = nearestStop(stops, position);
  if (position > from + NUDGE && nearest <= from + EPSILON) return stops.find((stop) => stop > from + EPSILON) ?? nearest;
  if (position < from - NUDGE && nearest >= from - EPSILON) return [...stops].reverse().find((stop) => stop < from - EPSILON) ?? nearest;
  return nearest;
}

/**
 * The stop a page in `direction` (-1 back, +1 on) moves to from `position`:
 * the furthest that keeps a little of the current view in sight, or the
 * next stop when the next is further than that.
 */
export function pageStop(stops: readonly number[], position: number, view: number, direction: -1 | 1): number {
  const ahead = stops.filter((stop) => (direction > 0 ? stop > position + EPSILON : stop < position - EPSILON));
  if (ahead.length === 0) return position;
  const reach = position + direction * view * PAGE;
  const within = ahead.filter((stop) => (direction > 0 ? stop <= reach : stop >= reach));
  if (within.length === 0) return direction > 0 ? ahead[0] : ahead[ahead.length - 1];
  return direction > 0 ? within[within.length - 1] : within[0];
}
// A page keeps the last eighth of the view it leaves in sight.
const PAGE = 0.875;

// ---------------------------------------------------------------------------
// The rims

export interface RimSide {
  /** How many parts lie wholly or partly past this edge. */
  beyond: number;
  /** How far into the view a part this edge cuts reaches, CSS pixels: the depth the fade there covers. 0 when it cuts none. */
  depth: number;
}

/**
 * What lies past each edge of `view` that the drawing continues past
 * (`continues`): the parts that lie that way, wholly or in part, past the
 * rail on that edge, and how deep the deepest part or mark the rail cuts
 * reaches into the view from the rim.
 */
export function readRim(parts: readonly View[], view: View, continues: Record<Side, boolean>, marks: readonly View[] = []): Record<Side, RimSide | null> {
  const clear = clearOf(view, continues);
  const reach = (side: Side, box: View): number | null => {
    switch (side) {
      case 'left':
        return box.left < clear.left - EPSILON ? Math.max(0, box.right - view.left) : null;
      case 'right':
        return box.right > clear.right + EPSILON ? Math.max(0, view.right - box.left) : null;
      case 'top':
        return box.top < clear.top - EPSILON ? Math.max(0, box.bottom - view.top) : null;
      case 'bottom':
        return box.bottom > clear.bottom + EPSILON ? Math.max(0, view.bottom - box.top) : null;
    }
  };
  const read = (side: Side): RimSide | null => {
    if (!continues[side]) return null;
    let beyond = 0;
    let depth = 0;
    for (const part of parts) {
      const past = reach(side, part);
      if (past === null) continue;
      beyond += 1;
      depth = Math.max(depth, past);
    }
    for (const mark of marks) depth = Math.max(depth, reach(side, mark) ?? 0);
    return { beyond, depth };
  };
  return { left: read('left'), right: read('right'), top: read('top'), bottom: read('bottom') };
}

/** The view less the rails on the edges the drawing continues past: what is shown clear of them. */
export function clearOf(view: View, continues: Record<Side, boolean>): View {
  return {
    left: view.left + (continues.left ? RAIL : 0),
    right: view.right - (continues.right ? RAIL : 0),
    top: view.top + (continues.top ? RAIL : 0),
    bottom: view.bottom - (continues.bottom ? RAIL : 0),
  };
}

const inside = (part: View, view: View) =>
  part.left >= view.left - EPSILON && part.right <= view.right + EPSILON && part.top >= view.top - EPSILON && part.bottom <= view.bottom + EPSILON;

const contains = (point: Point, view: View) =>
  point.x >= view.left - EPSILON && point.x <= view.right + EPSILON && point.y >= view.top - EPSILON && point.y <= view.bottom + EPSILON;

/** A line leaving the view: where it crosses the rim, and the part it goes on to. */
export interface Exit {
  side: Side;
  /** Where along its rim it crosses: content pixels, x on the top and bottom rims, y on the left and right. */
  at: number;
  /** The part at its far end. */
  part: number;
  label: string;
  tone: string;
}

// Where the segment from `from` (in view) to `to` (out of it) first leaves the view.
function leaving(from: Point, to: Point, view: View): { side: Side; at: number } | null {
  let best: { t: number; side: Side; at: number } | null = null;
  const consider = (t: number, side: Side, at: number) => {
    if (t >= 0 && t <= 1 && (!best || t < best.t)) best = { t, side, at };
  };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx < 0 && to.x < view.left) consider((view.left - from.x) / dx, 'left', from.y + ((view.left - from.x) / dx) * dy);
  if (dx > 0 && to.x > view.right) consider((view.right - from.x) / dx, 'right', from.y + ((view.right - from.x) / dx) * dy);
  if (dy < 0 && to.y < view.top) consider((view.top - from.y) / dy, 'top', from.x + ((view.top - from.y) / dy) * dx);
  if (dy > 0 && to.y > view.bottom) consider((view.bottom - from.y) / dy, 'bottom', from.x + ((view.bottom - from.y) / dy) * dx);
  const found = best as { t: number; side: Side; at: number } | null;
  return found ? { side: found.side, at: found.at } : null;
}

/**
 * The lines that leave the view from a part shown whole for a part that is
 * not: each crosses the rim where it first leaves, walking from the part in
 * view, and is named for the part at its far end. Several lines to one
 * part across one rim are one exit, where the middle one crosses.
 */
export function findExits(parts: readonly View[], links: DrawingMap['links'], labels: readonly string[], place: Placement, view: View): Exit[] {
  const shown = parts.map((part) => inside(part, view));
  const groups = new Map<string, Exit[]>();
  for (const link of links) {
    if (shown[link.from] === undefined || shown[link.to] === undefined || shown[link.from] === shown[link.to]) continue;
    const near = shown[link.from] ? link.from : link.to;
    const far = near === link.from ? link.to : link.from;
    const route = link.points.map((point) => ({ x: place.offsetX + point.x * place.scale, y: place.offsetY + point.y * place.scale }));
    if (near === link.to) route.reverse();
    let crossing: { side: Side; at: number } | null = null;
    for (let index = 1; index < route.length && !crossing; index += 1) {
      if (contains(route[index - 1], view) && !contains(route[index], view)) crossing = leaving(route[index - 1], route[index], view);
    }
    if (!crossing) continue;
    const key = `${crossing.side}/${far}`;
    const exit: Exit = { side: crossing.side, at: crossing.at, part: far, label: labels[far] ?? '', tone: link.tone };
    groups.set(key, [...(groups.get(key) ?? []), exit]);
  }
  return [...groups.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.at - b.at);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  });
}

// ---------------------------------------------------------------------------
// The rails


/** The length, in CSS pixels, a tag takes along its rail for `chars` characters of the rail face (the mono face at 9px, 0.08em tracking: 0.6em advance plus the tracking), its chevron and padding. */
export function tagLength(chars: number): number {
  return (chars + 2) * TAG_ADVANCE + 2 * TAG_PAD;
}
const TAG_ADVANCE = 6.12;
const TAG_PAD = 5;
/** A tag's depth across its rail, CSS pixels. */
const TAG_DEPTH = 15;
/** A name longer than this is cut, with an ellipsis. */
export const EXIT_CHARS = 22;
// Room kept between two tags on one rail.
const TAG_GAP = 3;

/** An exit's tag placed on its rail: its box in the viewport, CSS pixels. */
export interface PlacedExit extends Exit {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Places each exit's tag on its rail, as near where its line crosses as
 * the others allow, clear of `avoid` (stretches of the rail taken by its
 * count and the map, in viewport pixels from the rail's start). A tag with
 * no room is left out; its rail's count still says the drawing goes on
 * that way. `inset` is the band pinned over the viewport's top, which the
 * side rails start under.
 */
export function placeExits(
  exits: readonly Exit[],
  scroll: { left: number; top: number },
  viewport: { width: number; height: number },
  avoid: Record<Side, ReadonlyArray<Span>>,
  inset = 0,
): PlacedExit[] {
  const tags: PlacedExit[] = [];
  for (const side of SIDES) {
    const vertical = side === 'left' || side === 'right';
    const start = vertical ? inset : 0;
    const end = vertical ? viewport.height : viewport.width;
    const blocked = [...avoid[side]].sort((a, b) => a[0] - b[0]);
    const mine = exits
      .filter((exit) => exit.side === side)
      .map((exit) => ({ exit, length: tagLength(Math.min(exit.label.length, EXIT_CHARS)), centre: exit.at - (vertical ? scroll.top : scroll.left) }))
      .sort((a, b) => a.centre - b.centre);
    let cursor = start;
    for (const { exit, length, centre } of mine) {
      let from = Math.max(cursor, Math.min(centre - length / 2, end - length));
      // Past each taken stretch it would overlap.
      for (const [low, high] of blocked) {
        if (from < high && from + length > low) from = Math.max(from, high + TAG_GAP);
      }
      if (from + length > end) continue;
      cursor = from + length + TAG_GAP;
      // Centred across its rail.
      const across = (RAIL - TAG_DEPTH) / 2;
      const far = (vertical ? viewport.width : viewport.height) - across - TAG_DEPTH;
      const offset = side === 'left' || side === 'top' ? across : far;
      tags.push(
        vertical
          ? { ...exit, x: offset, y: from, width: TAG_DEPTH, height: length }
          : { ...exit, x: from, y: offset, width: length, height: TAG_DEPTH },
      );
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// The map

// A drawing that scrolls less than this many views along its longest
// scrolling axis has no map: its rails say all there is to say.
const MAP_FROM = 1.6;
// The map takes about this share of the viewport's area, its long side no
// more than LONG of the viewport's matching side nor MAP_MAX pixels, its
// short side no more than SHORT of the viewport's.
const MAP_AREA = 0.02;
const MAP_LONG = 0.6;
const MAP_SHORT = 0.3;
const MAP_MAX = 300;

// Nor has a drawing in a viewport less deep or wide than this: there the
// map would cover too much of what it maps.
const MAP_ROOM = 180;

/** Whether a drawing `fitted` (its size on screen, CSS pixels) in `viewport` scrolls far enough, in room enough, to carry a map. */
export function wantsMap(fitted: { width: number; height: number }, viewport: { width: number; height: number }): boolean {
  return Math.min(viewport.width, viewport.height) >= MAP_ROOM && Math.max(fitted.width / viewport.width, fitted.height / viewport.height) >= MAP_FROM;
}

/** The size, in CSS pixels, of the map of a drawing (`drawing`, user units) in a viewport (CSS pixels). */
export function mapSize(drawing: { width: number; height: number }, viewport: { width: number; height: number }): { width: number; height: number } {
  const aspect = drawing.width / drawing.height;
  let width = Math.sqrt(MAP_AREA * viewport.width * viewport.height * aspect);
  let height = width / aspect;
  const limit = (cap: number, current: number) => {
    if (current <= cap) return;
    width *= cap / current;
    height *= cap / current;
  };
  const wide = aspect >= 1;
  limit(Math.min(MAP_MAX, viewport.width * (wide ? MAP_LONG : MAP_SHORT)), width);
  limit(Math.min(MAP_MAX, viewport.height * (wide ? MAP_SHORT : MAP_LONG)), height);
  return { width, height };
}

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
const CORNERS: readonly Corner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

/**
 * The corner the map stands in: the one that covers least of the drawing's
 * parts, where the drawing opens (`scroll`) and, as a reader scrolls, on
 * average over the views the drawing passes under it, the first counted
 * twice. The bottom right is kept on a tie, and the top is left to a
 * pinned band. `box` is the map's outer size with its margin, `parts` the
 * drawing's parts in content pixels, `viewport` the scroller's box,
 * `content` the scroll content's size.
 */
export function mapCorner(
  parts: readonly View[],
  viewport: { width: number; height: number },
  content: { width: number; height: number },
  scroll: { left: number; top: number },
  box: { width: number; height: number },
  pinned: boolean,
): Corner {
  const overlap = (low: number, high: number, start: number, end: number) => Math.max(0, Math.min(high, end) - Math.max(low, start));
  const covered = (x: Span, y: Span) => parts.reduce((sum, part) => sum + overlap(x[0], x[1], part.left, part.right) * overlap(y[0], y[1], part.top, part.bottom), 0);
  // How many views the drawing is along each axis: everything along an
  // axis that scrolls passes under the map once per view.
  const viewsX = Math.max(1, content.width / viewport.width);
  const viewsY = Math.max(1, content.height / viewport.height);
  const score = (corner: Corner) => {
    const right = corner.endsWith('right');
    const bottom = corner.startsWith('bottom');
    const at = (start: number, size: number, length: number, far: boolean): Span => (far ? [start + size - length, start + size] : [start, start + length]);
    const opening = covered(at(scroll.left, viewport.width, box.width, right), at(scroll.top, viewport.height, box.height, bottom));
    const sweepX: Span = viewsX > 1 ? [0, content.width] : at(0, viewport.width, box.width, right);
    const sweepY: Span = viewsY > 1 ? [0, content.height] : at(0, viewport.height, box.height, bottom);
    const passing = (viewsX > 1 ? covered(sweepX, at(scroll.top, viewport.height, box.height, bottom)) / viewsX : 0) +
      (viewsY > 1 ? covered(at(scroll.left, viewport.width, box.width, right), sweepY) / viewsY : 0);
    return 2 * opening + passing;
  };
  const candidates = CORNERS.filter((corner) => !(pinned && corner.startsWith('top')));
  return candidates.reduce((best, corner) => (score(corner) < score(best) - 1 ? corner : best), candidates[0]);
}
