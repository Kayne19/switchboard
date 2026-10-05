import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useElementSize } from '../hooks/useElementSize';
import { useLeastHeight } from '../hooks/useStageDemand';
import { SLIVER, type DrawingFit, type Size } from './drawingFit';
import {
  EXIT_CHARS,
  clearOf,
  RAIL,
  SIDES,
  findExits,
  keyStop,
  leadStop,
  mapInStrip,
  MAP_MARGIN,
  MAP_PAD,
  pageStop,
  placeExits,
  placed,
  readRim,
  restEnd,
  restStops,
  settleStop,
  tagLength,
  type DrawingMap,
  type MapStrip,
  type Placement,
  type Side,
  type Span,
  type View,
} from './drawingScroll';

// How much room the viewport's scroll bar takes, measured once on a probe
// styled as a scrolling viewport. The drawing's own map and rails stand in
// for a bar, so the stylesheet hides it and this reads 0; a browser that
// will not hide it still gets its room in the fit (drawingFit), though
// the rails and fades do not keep off it.
let scrollbarThickness: number | null = null;
function measureScrollbar(): number {
  if (scrollbarThickness !== null) return scrollbarThickness;
  const probe = document.createElement('div');
  probe.className = 'drawing-viewport__scroll';
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll;';
  document.body.append(probe);
  scrollbarThickness = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return scrollbarThickness;
}

/**
 * The viewport a drawing is read in, in CSS pixels: the host's layout size
 * once measured. Until then the first frame falls back to the screen's, so
 * a tall screen never flashes a wide drawing before the observer reports.
 */
export function useDrawingViewport(): { hostRef: RefObject<HTMLDivElement | null>; width: number; height: number; scrollbar: number } {
  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  const measured = size.width > 0 && size.height > 0;
  // An offset size is rounded to the pixel and may be up to half a pixel
  // over the box's own; a drawing sized to it would overflow by that much
  // and bring on a scroll bar. The viewport is taken a pixel short.
  const viewport: Size = measured ? { width: size.width - 1, height: size.height - 1 } : { width: window.innerWidth, height: window.innerHeight };
  const [scrollbar] = useState(measureScrollbar);
  return { hostRef, width: Math.max(1, Math.floor(viewport.width)), height: Math.max(1, Math.floor(viewport.height)), scrollbar };
}

/** A region of a drawing, in its user units. */
export interface DrawingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the scroller stands and how large its box is, CSS pixels. */
interface Reading {
  left: number;
  top: number;
  width: number;
  height: number;
}
const sameReading = (a: Reading | null, b: Reading) => a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

// A fade reaches past its rail at least this far, and covers what its edge
// cuts, up to this share of the view: a part mostly in view keeps the rest
// of itself clear, only its cut end faded.
const FADE_MIN = RAIL + 10;
const FADE_MAX = 0.22;
// The fade reaches this far past the inner edge of what it covers, so the
// cut part's frame there is dimmed too.
const FADE_LEAD = 10;
// The cut of the map frame's corner that faces the drawing.
const MAP_CUT = 7;
// How long input that moves the drawing freely (a wheel, a drag on the
// map) must pause before the drawing settles on a stop; and how long a
// scroller must go without moving to have stopped: briefly where the
// browser does not say when a scroll ends, and only as a guard where it
// does (a scroll asked to go where it already is never ends).
const SETTLE_MS = 140;
const SCROLL_IDLE_MS = 120;
const SCROLL_GUARD_MS = 1000;

/**
 * Calls `done` once `element` has stopped moving: at the browser's
 * `scrollend`; in a browser that sends none (WebKit long had none), once no
 * scroll event has come for SCROLL_IDLE_MS, however long the scroll takes.
 * Where `scrollend` exists the quiet spell must last SCROLL_GUARD_MS, so a
 * slow frame mid-scroll is not taken for its end. Returns what stops
 * listening.
 */
function whenScrollEnds(element: HTMLElement, done: () => void): () => void {
  const quiet = 'onscrollend' in element ? SCROLL_GUARD_MS : SCROLL_IDLE_MS;
  let timer = 0;
  const stop = () => {
    window.clearTimeout(timer);
    element.removeEventListener('scroll', moved);
    element.removeEventListener('scrollend', ended);
  };
  const ended = () => {
    stop();
    done();
  };
  const moved = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(ended, quiet);
  };
  element.addEventListener('scroll', moved);
  element.addEventListener('scrollend', ended);
  moved();
  return stop;
}

// A stop's band, CSS pixels: from the stop to the next (or to the
// content's end), where the browser settles the drawing at its start.
const bandLength = (stop: number, next: number | undefined, content: number) => Math.max(1, (next ?? content) - stop);

// The map's frame: its box with the corner that faces the drawing (it
// stands at the far end of its strip, so that is the top left) cut.
function mapFrame(width: number, height: number): string {
  const [x0, y0, x1, y1] = [0.5, 0.5, width - 0.5, height - 0.5];
  const points = [[x0, y0 + MAP_CUT], [x0 + MAP_CUT, y0], [x1, y0], [x1, y1], [x0, y1]];
  return `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad2 = (count: number) => String(count).padStart(2, '0');
const cut = (label: string) => (label.length > EXIT_CHARS ? `${label.slice(0, EXIT_CHARS - 1)}\u2026` : label);

/**
 * A drawing in its viewport (drawingFit.ts): contained when it fits at a
 * readable size; otherwise drawn at the fitted scale and scrolled, only
 * along the axis it overflows, inside the viewport, which clips it. The
 * viewport is the host's box, which the scene keeps inside its frame.
 *
 * A drawing that scrolls says where its reader is (drawingScroll.ts, given
 * its `map`): it rests only where the edge it is read from cuts no part,
 * opening on `lead` (what its note names, or where it begins); each edge it
 * continues past counts what lies that way and fades over what it still
 * cuts; a line that leaves the view names the part it goes to, at the rim;
 * and a map of the whole, the view boxed on it, stands in its `strip`
 * beside the drawing, where a tap or a drag moves the view. The strip is
 * the primitive's to reserve (drawingScroll `viewWithMap`), since the
 * drawing is laid out for the room it leaves. A `pinned` band (a sequence's actor
 * headers) stays at the viewport's top once the drawing has scrolled under
 * it, so a message far down still names its lifelines.
 */
export function DrawingViewport({
  drawing,
  fit,
  lead,
  pinned,
  map,
  strip,
  ariaLabel,
  children,
}: {
  drawing: Size;
  fit: DrawingFit;
  lead?: DrawingRegion | null;
  /** A band at the drawing's top (its headers, `height` user units deep) that stays in view while the rest scrolls under it. */
  pinned?: { height: number; content: ReactNode } | null;
  /** What the viewport tells its reader about the drawing when it scrolls. */
  map: DrawingMap;
  /** Where its map stands, beside the drawing; none for a drawing that carries no map. */
  strip?: MapStrip | null;
  ariaLabel: string;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  // What the drawing asks of the stage: the height it is read whole in at
  // its least readable scale, less the sliver it would be contained over.
  // Only a fit made for this viewport speaks for it: before its host is
  // measured a drawing is laid out for the screen, and a contained drawing
  // larger than its box, or a scrolling one wider or taller than it across
  // the axis it does not scroll, was fitted to another.
  const least = drawing.height * fit.minScale * (1 - SLIVER);
  useLeastHeight(
    viewportRef,
    useCallback(
      (box: { width: number; height: number }) =>
        (fit.scrollX || fit.width <= box.width + 1) && (fit.scrollY || fit.height <= box.height + 1) ? least : null,
      [fit.scrollX, fit.scrollY, fit.width, fit.height, least],
    ),
  );
  const scrolling = fit.scrollX || fit.scrollY;
  const axis = fit.scrollX && fit.scrollY ? 'both' : fit.scrollX ? 'x' : fit.scrollY ? 'y' : 'none';
  const pinnedDepth = pinned && fit.scrollY ? pinned.height * fit.scale : 0;

  const read = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !scrolling) {
      setReading(null);
      return;
    }
    // The band follows the drawing across, as it does not down.
    const band = pinnedRef.current;
    if (band) band.style.transform = `translateX(${Math.max(0, (element.clientWidth - fit.width) / 2) - element.scrollLeft}px)`;
    const next: Reading = { left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight };
    setReading((current) => (sameReading(current, next) ? current : next));
  }, [scrolling, fit.width]);

  // Scroll events come faster than frames: the rims are read once a frame.
  const frame = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      read();
    });
  }, [read]);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  // Where the drawing sits in the scroller (centred across an axis it does
  // not fill) and its parts there.
  const boxWidth = reading?.width ?? 0;
  const boxHeight = reading?.height ?? 0;
  const place = useMemo<Placement | null>(() => {
    if (!boxWidth || !boxHeight) return null;
    return {
      scale: fit.scale,
      offsetX: Math.max(0, (boxWidth - fit.width) / 2),
      offsetY: Math.max(0, (boxHeight - fit.height) / 2),
    };
  }, [boxWidth, boxHeight, fit.scale, fit.width, fit.height]);
  const parts = useMemo(() => (place ? map.parts.map((part) => placed(part.box, place)) : []), [map, place]);
  const marks = useMemo(() => (place ? map.marks.map((mark) => placed(mark, place)) : []), [map, place]);
  // The content's extent is the drawing's, or the box's across an axis the
  // drawing does not fill: read from the fit, never from the scroller,
  // whose extent the stops themselves stretch. At rest it may reach a
  // little past the drawing's end (restEnd), so the last place to rest
  // cuts no part either.
  const stopsFor = useCallback(
    (box: Pick<Reading, 'width' | 'height'>, boxes: View[], labels: View[]) => {
      const across = (part: View): Span => [part.left, part.right];
      const down = (part: View): Span => [part.top, part.bottom];
      const endX = fit.scrollX ? restEnd(boxes.map(across), Math.max(box.width, fit.width), box.width, 0, labels.map(across)) : box.width;
      const endY = fit.scrollY ? restEnd(boxes.map(down), Math.max(box.height, fit.height), box.height, pinnedDepth, labels.map(down)) : box.height;
      return {
        x: fit.scrollX ? restStops(boxes.map(across), endX, box.width, 0, labels.map(across)) : [0],
        y: fit.scrollY ? restStops(boxes.map(down), endY, box.height, pinnedDepth, labels.map(down)) : [0],
        endX,
        endY,
      };
    },
    [fit.scrollX, fit.scrollY, fit.width, fit.height, pinnedDepth],
  );
  // They follow the box and the drawing, not where the reader stands.
  const stops = useMemo(() => (place ? stopsFor({ width: boxWidth, height: boxHeight }, parts, marks) : null), [place, boxWidth, boxHeight, parts, marks, stopsFor]);
  // The scroll content at rest: the drawing (or the box across an axis the
  // drawing does not fill), and past its end what the last stop needs.
  const contentWidth = stops?.endX ?? Math.max(boxWidth, fit.width);
  const contentHeight = stops?.endY ?? Math.max(boxHeight, fit.height);
  const extent = useRef({ width: contentWidth, height: contentHeight });
  extent.current = { width: contentWidth, height: contentHeight };

  // The drawing opens on its lead region when it is first drawn and
  // whenever what is drawn changes shape (its size, its scale, or the
  // region it leads with), at the place to rest nearest centring it. An
  // update that leaves those alone (a node's state, a resize that does not
  // move the scale) keeps the reader where they are.
  // A drawing with no lead (an exchange read from its start) opens at its
  // start once, and is not sent back there when it only grows or shrinks:
  // a message added, or headers grown to hold a NOTE marker.
  const leadX = lead ? lead.x + lead.width / 2 : null;
  const leadY = lead ? lead.y + lead.height / 2 : null;
  const shape = `${lead ? `${drawing.width}x${drawing.height}` : 'start'}@${fit.scale}/${axis}/${leadX},${leadY}`;
  const endRef = useRef<HTMLSpanElement>(null);
  const shownShape = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && scrolling && shownShape.current !== shape) {
      const sizes = { width: element.clientWidth, height: element.clientHeight };
      const opening: Placement = {
        scale: fit.scale,
        offsetX: Math.max(0, (sizes.width - fit.width) / 2),
        offsetY: Math.max(0, (sizes.height - fit.height) / 2),
      };
      const leadBox = lead ? placed(lead, opening) : null;
      const boxes = map.parts.map((part) => placed(part.box, opening));
      const opened = stopsFor(sizes, boxes, map.marks.map((mark) => placed(mark, opening)));
      // The content's room at rest is made before the drawing is moved into it.
      endRef.current?.style.setProperty('left', `${opened.endX - 1}px`);
      endRef.current?.style.setProperty('top', `${opened.endY - 1}px`);
      element.scrollLeft = leadBox ? leadStop(opened.x, [leadBox.left, leadBox.right], sizes.width, 0, boxes.map((box): Span => [box.left, box.right])) : 0;
      element.scrollTop = leadBox ? leadStop(opened.y, [leadBox.top, leadBox.bottom], sizes.height, pinnedDepth, boxes.map((box): Span => [box.top, box.bottom])) : 0;
    }
    shownShape.current = shape;
    // The rims and the band follow every render: a resize or an update
    // can change what lies past each edge without moving the reader.
    read();
  });

  // Moving freely (a wheel, a drag on the map) lets go of the stops; once
  // the input pauses, the drawing settles on a stop: the nearest, or, when
  // the input moved it on from where it rested, the next one that way, so
  // a single notch of a wheel still turns to the next part.
  const settleTimer = useRef<number | null>(null);
  const settling = useRef<(() => void) | null>(null);
  const freeFrom = useRef<{ left: number; top: number } | null>(null);
  const settle = useCallback(() => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settling.current?.();
    settling.current = null;
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      const element = scrollRef.current;
      const from = freeFrom.current ?? { left: element?.scrollLeft ?? 0, top: element?.scrollTop ?? 0 };
      freeFrom.current = null;
      if (element) {
        const sizes = { width: element.clientWidth, height: element.clientHeight };
        const now: Placement = { scale: fit.scale, offsetX: Math.max(0, (sizes.width - fit.width) / 2), offsetY: Math.max(0, (sizes.height - fit.height) / 2) };
        const resting = stopsFor(sizes, map.parts.map((part) => placed(part.box, now)), map.marks.map((mark) => placed(mark, now)));
        const smooth = !reducedMotion();
        element.scrollTo({
          left: settleStop(resting.x, from.left, element.scrollLeft),
          top: settleStop(resting.y, from.top, element.scrollTop),
          behavior: smooth ? 'smooth' : 'auto',
        });
        // The stops hold it again once it has arrived, not before: a
        // browser may snap afresh when they come back, and mid-flight that
        // would be to the stop nearest wherever the scroll had got to.
        if (smooth) {
          settling.current = whenScrollEnds(element, () => {
            settling.current = null;
            if (freeFrom.current === null) element.style.scrollSnapType = '';
          });
          return;
        }
        element.style.scrollSnapType = '';
      }
    }, SETTLE_MS);
  }, [map, fit.scale, fit.width, fit.height, stopsFor]);
  // The stops are let go on the element itself, at once: a scroll set
  // before a render would let them go would be snapped straight back.
  const letGo = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (freeFrom.current === null) freeFrom.current = { left: element.scrollLeft, top: element.scrollTop };
    element.style.scrollSnapType = 'none';
  }, []);
  useEffect(() => () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settling.current?.();
  }, []);

  // A wheel or a trackpad moves the drawing freely, then it settles. A
  // wheel turned over a drawing that scrolls only across scrolls it across:
  // a mouse has no other way there. It is heard over the whole viewport,
  // the map and the rails' counts as well as the drawing.
  useEffect(() => {
    const element = scrollRef.current;
    const viewport = viewportRef.current;
    if (!element || !viewport || axis === 'none') return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (axis === 'x' ? element.clientWidth : element.clientHeight) : 1;
      let dx = event.deltaX * unit;
      let dy = event.deltaY * unit;
      if (axis === 'x' && Math.abs(dy) > Math.abs(dx)) [dx, dy] = [dy, 0];
      if (axis === 'x') dy = 0;
      if (axis === 'y') dx = 0;
      // At its end that way, the wheel is not held.
      const room = (delta: number, at: number, length: number) => (delta < 0 ? at > 0.5 : at < length - 0.5);
      const maxLeft = extent.current.width - element.clientWidth;
      const maxTop = extent.current.height - element.clientHeight;
      if (!(dx && room(dx, element.scrollLeft, maxLeft)) && !(dy && room(dy, element.scrollTop, maxTop))) return;
      event.preventDefault();
      letGo();
      element.scrollLeft += dx;
      element.scrollTop += dy;
      settle();
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [axis, letGo, settle]);

  // A key or a count moves the drawing to a stop, smoothly. A second press
  // while it is on its way moves on from where the first is going, not
  // from where the scroll has got to (which would give the same stop
  // again): the stop it is gliding to is kept until the scroll ends.
  const gliding = useRef<{ left: number | null; top: number | null; stop: (() => void) | null }>({ left: null, top: null, stop: null });
  const standing = (element: HTMLElement, across: boolean) => (across ? (gliding.current.left ?? element.scrollLeft) : (gliding.current.top ?? element.scrollTop));
  const glide = (element: HTMLElement, across: boolean, target: number) => {
    const smooth = !reducedMotion();
    element.scrollTo({ [across ? 'left' : 'top']: target, behavior: smooth ? 'smooth' : 'auto' });
    if (!smooth) return;
    gliding.current.stop?.();
    gliding.current = {
      ...gliding.current,
      [across ? 'left' : 'top']: target,
      stop: whenScrollEnds(element, () => {
        gliding.current = { left: null, top: null, stop: null };
      }),
    };
  };
  useEffect(() => () => gliding.current.stop?.(), []);

  // The keys that scroll a focused viewport move it from stop to stop, so
  // it rests between its parts as it does after any other input. Each key
  // it takes is marked handled (FocusableSurface's rule): the surface
  // around it leaves Space alone rather than expanding the object, and
  // Enter, which it does not take, still expands it. The arrows move along
  // their own axis; the page keys, Home and End along the one it is read
  // down (or across, when it scrolls only across).
  const scrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!element || !stops || event.altKey || event.ctrlKey || event.metaKey) return;
    const main = fit.scrollY ? 'y' : 'x';
    for (const along of ['x', 'y'] as const) {
      if (!(along === 'x' ? fit.scrollX : fit.scrollY)) continue;
      const across = along === 'x';
      const arrow = event.key.startsWith('Arrow');
      if (!arrow && along !== main) continue;
      const target = across
        ? keyStop(event.key, event.shiftKey, true, stops.x, standing(element, true), element.clientWidth)
        : keyStop(event.key, event.shiftKey, false, stops.y, standing(element, false), element.clientHeight - pinnedDepth);
      if (target === null) continue;
      event.preventDefault();
      glide(element, across, target);
      return;
    }
  };

  // A tap on a rim's count turns a page that way. The tap is marked handled,
  // so the surface around the drawing does not expand the object.
  const page = (side: Side) => (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const element = scrollRef.current;
    if (!element || !stops) return;
    const across = side === 'left' || side === 'right';
    const direction = side === 'left' || side === 'top' ? -1 : 1;
    const target = across
      ? pageStop(stops.x, standing(element, true), element.clientWidth, direction)
      : pageStop(stops.y, standing(element, false), element.clientHeight - pinnedDepth, direction);
    glide(element, across, target);
  };

  // What the rims say, from where the reader stands.
  const inset = reading && reading.top > 0.5 ? pinnedDepth : 0;
  const view = useMemo<View | null>(
    () => (reading ? { left: reading.left, top: reading.top + inset, right: reading.left + reading.width, bottom: reading.top + reading.height } : null),
    [reading, inset],
  );
  // An axis it overflows by no more than a rail is its own margin: it
  // rests at its start (restStops) and has no rails.
  const continues = useMemo<Record<Side, boolean>>(() => {
    if (!reading) return { left: false, right: false, top: false, bottom: false };
    const across = contentWidth - reading.width > RAIL;
    const down = contentHeight - reading.height > RAIL;
    return {
      left: across && reading.left > 0.5,
      right: across && reading.left + reading.width < contentWidth - 0.5,
      top: down && reading.top > 0.5,
      bottom: down && reading.top + reading.height < contentHeight - 0.5,
    };
  }, [reading, contentWidth, contentHeight]);
  const rim = useMemo(() => (view ? readRim(parts, view, continues, marks) : null), [parts, marks, view, continues]);
  // The map, in its strip, at the strip's far end: as deep as the strip
  // and as long as the drawing's shape makes it.
  const stripLength = strip?.side === 'bottom' ? boxWidth : boxHeight;
  const mapBox = useMemo(() => (strip && stripLength ? mapInStrip(drawing, strip, stripLength) : null), [drawing, strip, stripLength]);
  // Each rim's count of what lies that way: "07 NODES".
  const rimTexts = useMemo(() => {
    const text = (side: Side) => {
      const count = rim?.[side]?.beyond ?? 0;
      return count > 0 ? `${pad2(count)} ${count === 1 ? map.noun.one : map.noun.many}` : '';
    };
    return { left: text('left'), right: text('right'), top: text('top'), bottom: text('bottom') };
  }, [rim, map]);
  // Where each rail's count stands: in its middle (the side rails start
  // under a pinned band).
  const rails = useMemo(() => {
    const centre = (side: Side) => (side === 'left' || side === 'right' ? (inset + boxHeight) / 2 : boxWidth / 2);
    return { left: centre('left'), right: centre('right'), top: centre('top'), bottom: centre('bottom') };
  }, [inset, boxWidth, boxHeight]);
  const exits = useMemo(() => {
    if (!reading || !place || !view || map.links.length === 0) return [];
    // Along each rail, the names keep off its count.
    const along = (side: Side): Span[] => {
      const text = rimTexts[side];
      return text ? [[rails[side] - tagLength(text.length) / 2 - 4, rails[side] + tagLength(text.length) / 2 + 4]] : [];
    };
    const found = findExits(parts, map.links, map.parts.map((part) => part.label), place, clearOf(view, continues));
    return placeExits(found, reading, reading, { left: along('left'), right: along('right'), top: along('top'), bottom: along('bottom') }, inset);
  }, [map, reading, place, view, continues, parts, rimTexts, rails, inset]);

  // The map: a tap or a drag centres the view where it points.
  const dragging = useRef(false);
  const showAt = (event: PointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!element || !mapBox || !place) return;
    const bounds = (event.currentTarget.querySelector('.drawing-viewport__map-sketch') ?? event.currentTarget).getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * drawing.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * drawing.height;
    element.scrollLeft = place.offsetX + x * place.scale - element.clientWidth / 2;
    element.scrollTop = place.offsetY + y * place.scale - (element.clientHeight + pinnedDepth) / 2;
  };
  const mapWindow =
    reading && place
      ? {
          x: (reading.left - place.offsetX) / place.scale,
          y: (reading.top + inset - place.offsetY) / place.scale,
          width: reading.width / place.scale,
          height: (reading.height - inset) / place.scale,
        }
      : null;

  // The snap bands and the map's sketch change with the drawing and the
  // box, not as the reader scrolls: they are not rebuilt every frame.
  const bands = useMemo(
    () =>
      stops ? (
        <div className="drawing-viewport__stops" aria-hidden="true">
          {fit.scrollX
            ? stops.x.map((stop, index) => (
                <span
                  key={`x${stop}`}
                  className="drawing-viewport__stop"
                  style={{ left: `${stop}px`, width: `${bandLength(stop, stops.x[index + 1], contentWidth)}px`, height: `${contentHeight}px`, scrollSnapAlign: 'none start' }}
                />
              ))
            : null}
          {fit.scrollY
            ? stops.y.map((stop, index) => (
                <span
                  key={`y${stop}`}
                  className="drawing-viewport__stop"
                  style={{ top: `${stop}px`, height: `${bandLength(stop, stops.y[index + 1], contentHeight)}px`, width: `${contentWidth}px`, scrollSnapAlign: 'start none' }}
                />
              ))
            : null}
        </div>
      ) : null,
    [stops, fit.scrollX, fit.scrollY, contentWidth, contentHeight],
  );
  const sketch = useMemo(
    () => (
      <>
        {map.sketch.lines.map((line, index) => (
          <polyline key={`l${index}`} className="drawing-viewport__map-line" points={line.points.map((point) => `${point.x},${point.y}`).join(' ')} stroke={line.tone} />
        ))}
        {map.sketch.boxes.map((item, index) => (
          <rect key={`b${index}`} className="drawing-viewport__map-box" x={item.box.x} y={item.box.y} width={item.box.width} height={item.box.height} fill={item.tone} />
        ))}
      </>
    ),
    [map],
  );
  // A drag on the map ends however the pointer leaves it.
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    settle();
  };

  const fadeDepth = (side: Side) => {
    const reach = rim?.[side];
    if (!reach || !reading) return 0;
    const span = side === 'left' || side === 'right' ? reading.width : reading.height;
    return Math.max(FADE_MIN, Math.min(span * FADE_MAX, reach.depth > 0 ? reach.depth + FADE_LEAD : 0));
  };

  return (
    <div
      ref={viewportRef}
      className={`drawing-viewport${scrolling ? ' drawing-viewport--scrolling' : ''}${strip ? ` drawing-viewport--strip-${strip.side}` : ''}`}
      data-scroll={axis}
    >
      <div className="drawing-viewport__view">
        <div
          ref={scrollRef}
          className="drawing-viewport__scroll"
          tabIndex={scrolling ? 0 : undefined}
          onScroll={scrolling ? onScroll : undefined}
          onKeyDown={scrolling ? scrollKeys : undefined}
        >
          <svg
            viewBox={`0 0 ${drawing.width} ${drawing.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={ariaLabel}
            style={scrolling ? { width: `${fit.width}px`, height: `${fit.height}px` } : undefined}
          >
            {children}
          </svg>
          {bands}
          {scrolling ? <span ref={endRef} className="drawing-viewport__end" style={{ left: `${contentWidth - 1}px`, top: `${contentHeight - 1}px` }} /> : null}
        </div>
        {pinned && fit.scrollY ? (
          <div className={`drawing-viewport__pinned${inset > 0 ? ' drawing-viewport__pinned--shown' : ''}`} style={{ height: `${pinnedDepth}px` }} aria-hidden="true">
            <div ref={pinnedRef} className="drawing-viewport__pinned-drawing" style={{ width: `${fit.width}px` }}>
              <svg viewBox={`0 0 ${drawing.width} ${pinned.height}`} preserveAspectRatio="xMidYMin meet">
                {pinned.content}
              </svg>
            </div>
          </div>
        ) : null}
        {SIDES.map((side) =>
          continues[side] ? (
            <div
              key={side}
              className={`drawing-viewport__more drawing-viewport__more--${side}`}
              style={{ [side === 'left' || side === 'right' ? 'width' : 'height']: `${fadeDepth(side)}px`, ...(side === 'bottom' ? null : { top: `${inset}px` }) }}
              aria-hidden="true"
            />
          ) : null,
        )}
        {SIDES.map((side) =>
          rimTexts[side] ? (
            <div key={side} className={`drawing-viewport__rail drawing-viewport__rail--${side}`} style={side === 'bottom' ? undefined : { top: `${inset}px` }} aria-hidden="true" />
          ) : null,
        )}
        {exits.length > 0 ? (
          <div className="drawing-viewport__exits" aria-hidden="true">
            {exits.map((exit) => (
              <span
                key={`${exit.side}/${exit.part}`}
                className={`drawing-viewport__exit drawing-viewport__exit--${exit.side}`}
                style={{
                  left: `${exit.x + exit.width / 2}px`,
                  top: `${exit.y + exit.height / 2}px`,
                  width: `${Math.max(exit.width, exit.height)}px`,
                  color: exit.tone,
                }}
              >
                {cut(exit.label)}
              </span>
            ))}
          </div>
        ) : null}
        {SIDES.map((side) => {
          const text = rimTexts[side];
          return text ? (
            <div
              key={side}
              className={`drawing-viewport__rim drawing-viewport__rim--${side}`}
              style={side === 'left' || side === 'right' ? { top: `${rails[side]}px` } : { left: `${rails[side]}px`, ...(side === 'top' ? { top: `${inset}px` } : null) }}
              onClick={page(side)}
              aria-hidden="true"
            >
              <span className="drawing-viewport__rim-text">{text}</span>
              <svg className="drawing-viewport__chevron" viewBox="0 0 8 6" aria-hidden="true">
                <path d="M 4 0 L 8 6 L 0 6 Z" />
              </svg>
            </div>
          ) : null;
        })}
      </div>
      {strip ? (
        <div className="drawing-viewport__strip" style={{ [strip.side === 'bottom' ? 'height' : 'width']: `${strip.depth}px` }}>
          {mapBox && mapWindow ? (
            <div
              className="drawing-viewport__map"
              style={{ width: `${mapBox.width}px`, height: `${mapBox.height}px`, padding: `${MAP_PAD}px`, right: `${MAP_MARGIN}px`, bottom: `${MAP_MARGIN}px` }}
              aria-hidden="true"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragging.current = true;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                letGo();
                showAt(event);
              }}
              onPointerMove={(event) => {
                if (dragging.current) showAt(event);
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                endDrag();
              }}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onClick={(event) => event.preventDefault()}
            >
              <svg className="drawing-viewport__map-frame" viewBox={`0 0 ${mapBox.width + 2 * MAP_PAD} ${mapBox.height + 2 * MAP_PAD}`} preserveAspectRatio="none">
                <path d={mapFrame(mapBox.width + 2 * MAP_PAD, mapBox.height + 2 * MAP_PAD)} />
              </svg>
              <svg className="drawing-viewport__map-sketch" viewBox={`0 0 ${drawing.width} ${drawing.height}`} preserveAspectRatio="none">
                {sketch}
                <rect className="drawing-viewport__map-view" x={mapWindow.x} y={mapWindow.y} width={mapWindow.width} height={mapWindow.height} />
              </svg>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
