import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useElementSize } from '../hooks/useElementSize';
import type { DrawingFit, Size } from './drawingFit';
import {
  EXIT_CHARS,
  clearOf,
  RAIL,
  SIDES,
  findExits,
  leadStop,
  mapCorner,
  mapSize,
  pageStop,
  placeExits,
  placed,
  readRim,
  restStops,
  settleStop,
  tagLength,
  wantsMap,
  type Corner,
  type DrawingMap,
  type Placement,
  type Side,
  type Span,
  type View,
} from './drawingScroll';

// How much room the viewport's scroll bar takes, measured once on a probe
// styled as a scrolling viewport. The drawing's own map and rims stand in
// for a bar, so the stylesheet hides it and this reads 0; a browser that
// will not hide it still gets its room.
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

const SCROLL_KEYS = new Set([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
// A fade reaches past its rail at least this far, and covers what its edge
// cuts, up to this share of the view: past that a part mostly in view stays
// readable, its cut end faded.
const FADE_MIN = RAIL + 10;
const FADE_MAX = 0.22;
// The fade reaches this far past the inner edge of what it covers, so the
// cut part's frame there is dimmed too.
const FADE_LEAD = 10;
// The map's margin from the viewport's corner, its padding inside its
// frame (.drawing-viewport__map), and the cut of the frame's corner.
const MAP_MARGIN = 6;
const MAP_PAD = 4;
const MAP_CUT = 7;
// How long input that moves the drawing freely (a mapped wheel, a drag on
// the map) must pause before the drawing settles on a stop.
const SETTLE_MS = 140;

// A stop's band, CSS pixels: from the stop to the next (or to the
// content's end), where the browser settles the drawing at its start.
const bandLength = (stop: number, next: number | undefined, content: number) => Math.max(1, (next ?? content) - stop);

// The map's frame: its box with the corner that faces the drawing cut.
function mapFrame(width: number, height: number, corner: Corner): string {
  const [x0, y0, x1, y1] = [0.5, 0.5, width - 0.5, height - 0.5];
  const points =
    corner === 'bottom-right'
      ? [[x0, y0 + MAP_CUT], [x0 + MAP_CUT, y0], [x1, y0], [x1, y1], [x0, y1]]
      : corner === 'bottom-left'
        ? [[x0, y0], [x1 - MAP_CUT, y0], [x1, y0 + MAP_CUT], [x1, y1], [x0, y1]]
        : corner === 'top-right'
          ? [[x0, y0], [x1, y0], [x1, y1], [x0 + MAP_CUT, y1], [x0, y1 - MAP_CUT]]
          : [[x0, y0], [x1, y0], [x1, y1 - MAP_CUT], [x1 - MAP_CUT, y1], [x0, y1]];
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
 * and a map of the whole, the view boxed on it, stands in the corner, where
 * a tap or a drag moves the view. A `pinned` band (a sequence's actor
 * headers) stays at the viewport's top once the drawing has scrolled under
 * it, so a message far down still names its lifelines.
 */
export function DrawingViewport({
  drawing,
  fit,
  lead,
  pinned,
  map,
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
  ariaLabel: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState<Reading | null>(null);
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
  // The scroll content: the drawing, or the box across an axis the drawing does not fill.
  const contentWidth = Math.max(boxWidth, fit.width);
  const contentHeight = Math.max(boxHeight, fit.height);
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
  // whose extent the stops themselves could stretch.
  const stopsFor = useCallback(
    (box: Pick<Reading, 'width' | 'height'>, boxes: View[], labels: View[]) => ({
      x: fit.scrollX
        ? restStops(boxes.map((part): Span => [part.left, part.right]), Math.max(box.width, fit.width), box.width, 0, labels.map((mark): Span => [mark.left, mark.right]))
        : [0],
      y: fit.scrollY
        ? restStops(boxes.map((part): Span => [part.top, part.bottom]), Math.max(box.height, fit.height), box.height, pinnedDepth, labels.map((mark): Span => [mark.top, mark.bottom]))
        : [0],
    }),
    [fit.scrollX, fit.scrollY, fit.width, fit.height, pinnedDepth],
  );
  // They follow the box and the drawing, not where the reader stands.
  const stops = useMemo(() => (place ? stopsFor({ width: boxWidth, height: boxHeight }, parts, marks) : null), [place, boxWidth, boxHeight, parts, marks, stopsFor]);

  // The drawing opens on its lead region when it is first drawn and
  // whenever what is drawn changes shape (its size, its scale, or the
  // region it leads with), at the place to rest nearest centring it. An
  // update that leaves those alone (a node's state, a resize that does not
  // move the scale) keeps the reader where they are.
  const leadX = lead ? lead.x + lead.width / 2 : null;
  const leadY = lead ? lead.y + lead.height / 2 : null;
  const shape = `${drawing.width}x${drawing.height}@${fit.scale}/${axis}/${leadX},${leadY}`;
  const shownShape = useRef<string | null>(null);
  const [openedAt, setOpenedAt] = useState({ left: 0, top: 0 });
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
      element.scrollLeft = leadBox ? leadStop(opened.x, [leadBox.left, leadBox.right], sizes.width, 0, boxes.map((box): Span => [box.left, box.right])) : 0;
      element.scrollTop = leadBox ? leadStop(opened.y, [leadBox.top, leadBox.bottom], sizes.height, pinnedDepth, boxes.map((box): Span => [box.top, box.bottom])) : 0;
      setOpenedAt({ left: element.scrollLeft, top: element.scrollTop });
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
  const freeFrom = useRef<{ left: number; top: number } | null>(null);
  const settle = useCallback(() => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      const element = scrollRef.current;
      const from = freeFrom.current ?? { left: element?.scrollLeft ?? 0, top: element?.scrollTop ?? 0 };
      freeFrom.current = null;
      if (element) {
        const sizes = { width: element.clientWidth, height: element.clientHeight };
        const now: Placement = { scale: fit.scale, offsetX: Math.max(0, (sizes.width - fit.width) / 2), offsetY: Math.max(0, (sizes.height - fit.height) / 2) };
        const resting = stopsFor(sizes, map.parts.map((part) => placed(part.box, now)), map.marks.map((mark) => placed(mark, now)));
        element.scrollTo({
          left: settleStop(resting.x, from.left, element.scrollLeft),
          top: settleStop(resting.y, from.top, element.scrollTop),
          behavior: reducedMotion() ? 'auto' : 'smooth',
        });
      }
      if (element) element.style.scrollSnapType = '';
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
  }, []);

  // A wheel or a trackpad moves the drawing freely, then it settles. A
  // wheel turned over a drawing that scrolls only across scrolls it across:
  // a mouse has no other way there.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || axis === 'none') return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (axis === 'x' ? element.clientWidth : element.clientHeight) : 1;
      let dx = event.deltaX * unit;
      let dy = event.deltaY * unit;
      if (axis === 'x' && Math.abs(dy) > Math.abs(dx)) [dx, dy] = [dy, 0];
      if (axis === 'x') dy = 0;
      if (axis === 'y') dx = 0;
      // At its end that way, the wheel is not held: it may scroll what holds the drawing.
      const room = (delta: number, at: number, length: number) => (delta < 0 ? at > 0.5 : at < length - 0.5);
      const maxLeft = Math.max(element.clientWidth, fit.width) - element.clientWidth;
      const maxTop = Math.max(element.clientHeight, fit.height) - element.clientHeight;
      if (!(dx && room(dx, element.scrollLeft, maxLeft)) && !(dy && room(dy, element.scrollTop, maxTop))) return;
      event.preventDefault();
      letGo();
      element.scrollLeft += dx;
      element.scrollTop += dy;
      settle();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [axis, fit.width, fit.height, letGo, settle]);

  // Keys that scroll a focused viewport scroll it; they do not reach the
  // surface around it, which would take Space as "expand".
  const keepScrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(event.key)) event.stopPropagation();
  };

  // A tap on a rim's count turns a page that way; it does not expand the
  // object around the drawing.
  const page = (side: Side) => (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const element = scrollRef.current;
    if (!element || !stops) return;
    const across = side === 'left' || side === 'right';
    const direction = side === 'left' || side === 'top' ? -1 : 1;
    const target = across
      ? pageStop(stops.x, element.scrollLeft, element.clientWidth, direction)
      : pageStop(stops.y, element.scrollTop, element.clientHeight - pinnedDepth, direction);
    element.scrollTo({ [across ? 'left' : 'top']: target, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  // What the rims say, from where the reader stands.
  const inset = reading && reading.top > 0.5 ? pinnedDepth : 0;
  const view = useMemo<View | null>(
    () => (reading ? { left: reading.left, top: reading.top + inset, right: reading.left + reading.width, bottom: reading.top + reading.height } : null),
    [reading, inset],
  );
  const continues = useMemo<Record<Side, boolean>>(
    () =>
      reading
        ? {
            left: reading.left > 0.5,
            right: reading.left + reading.width < Math.max(reading.width, fit.width) - 0.5,
            top: reading.top > 0.5,
            bottom: reading.top + reading.height < Math.max(reading.height, fit.height) - 0.5,
          }
        : { left: false, right: false, top: false, bottom: false },
    [reading, fit.width, fit.height],
  );
  const rim = useMemo(() => (view ? readRim(parts, view, continues, marks) : null), [parts, marks, view, continues]);
  // The map, for a drawing that scrolls far enough to need one, in the
  // corner it covers least of, chosen when the drawing opens and kept.
  const mapBox = useMemo(
    () => (boxWidth && boxHeight && wantsMap(fit, { width: boxWidth, height: boxHeight }) ? mapSize(drawing, { width: boxWidth, height: boxHeight }) : null),
    [drawing, fit, boxWidth, boxHeight],
  );
  const corner = useMemo<Corner>(() => {
    if (!mapBox) return 'bottom-right';
    const outer = { width: mapBox.width + 2 * MAP_PAD + 2 * MAP_MARGIN, height: mapBox.height + 2 * MAP_PAD + 2 * MAP_MARGIN };
    const content = { width: Math.max(boxWidth, fit.width), height: Math.max(boxHeight, fit.height) };
    return mapCorner(parts, { width: boxWidth, height: boxHeight }, content, openedAt, outer, pinnedDepth > 0);
  }, [mapBox, parts, boxWidth, boxHeight, fit.width, fit.height, pinnedDepth, openedAt]);
  // Each rim's count of what lies that way: "07 NODES".
  const rimTexts = useMemo(() => {
    const text = (side: Side) => {
      const count = rim?.[side]?.beyond ?? 0;
      return count > 0 ? `${pad2(count)} ${count === 1 ? map.noun.one : map.noun.many}` : '';
    };
    return { left: text('left'), right: text('right'), top: text('top'), bottom: text('bottom') };
  }, [rim, map]);
  const exits = useMemo(() => {
    if (!reading || !place || !view || map.links.length === 0) return [];
    // Along each rim, the tags keep off its count and off the map.
    const along = (side: Side): Span[] => {
      const vertical = side === 'left' || side === 'right';
      const length = vertical ? reading.height : reading.width;
      const text = rimTexts[side];
      const room: Span[] = [];
      if (text) {
        const extent = tagLength(text.length);
        const centre = vertical ? (inset + length) / 2 : length / 2;
        room.push([centre - extent / 2 - 4, centre + extent / 2 + 4]);
      }
      if (mapBox && corner.includes(side)) {
        const mapLength = (vertical ? mapBox.height : mapBox.width) + 2 * MAP_PAD + 2 * MAP_MARGIN;
        const atEnd = vertical ? corner.startsWith('bottom') : corner.endsWith('right');
        room.push(atEnd ? [length - mapLength, length] : [0, mapLength]);
      }
      return room;
    };
    const found = findExits(parts, map.links, map.parts.map((part) => part.label), place, clearOf(view, continues));
    return placeExits(found, reading, reading, { left: along('left'), right: along('right'), top: along('top'), bottom: along('bottom') }, inset);
  }, [map, reading, place, view, continues, parts, rimTexts, mapBox, corner, inset]);

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

  const fadeDepth = (side: Side) => {
    const reach = rim?.[side];
    if (!reach || !reading) return 0;
    const span = side === 'left' || side === 'right' ? reading.width : reading.height;
    return Math.max(FADE_MIN, Math.min(span * FADE_MAX, reach.depth > 0 ? reach.depth + FADE_LEAD : 0));
  };

  return (
    <div className={`drawing-viewport${scrolling ? ' drawing-viewport--scrolling' : ''}`} data-scroll={axis}>
      <div
        ref={scrollRef}
        className="drawing-viewport__scroll"
        tabIndex={scrolling ? 0 : undefined}
        onScroll={scrolling ? onScroll : undefined}
        onKeyDown={scrolling ? keepScrollKeys : undefined}
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
        {stops && reading ? (
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
        ) : null}
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
            style={{ [side === 'left' || side === 'right' ? 'width' : 'height']: `${fadeDepth(side)}px`, ...(side === 'top' ? { top: `${inset}px` } : null) }}
            aria-hidden="true"
          />
        ) : null,
      )}
      {SIDES.map((side) =>
        rimTexts[side] ? (
          <div key={side} className={`drawing-viewport__rail drawing-viewport__rail--${side}`} style={side === 'top' ? { top: `${inset}px` } : undefined} aria-hidden="true" />
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
            style={side === 'top' ? { top: `${inset}px` } : side === 'left' || side === 'right' ? { top: `${(inset + (reading?.height ?? 0)) / 2}px` } : undefined}
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
      {mapBox && mapWindow ? (
        <div
          className={`drawing-viewport__map drawing-viewport__map--${corner}`}
          style={{ width: `${mapBox.width}px`, height: `${mapBox.height}px` }}
          aria-hidden="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            letGo();
            showAt(event);
          }}
          onPointerMove={(event) => {
            if (dragging.current) showAt(event);
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            settle();
          }}
          onPointerCancel={() => {
            dragging.current = false;
            settle();
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <svg className="drawing-viewport__map-frame" viewBox={`0 0 ${mapBox.width + 2 * MAP_PAD} ${mapBox.height + 2 * MAP_PAD}`} preserveAspectRatio="none">
            <path d={mapFrame(mapBox.width + 2 * MAP_PAD, mapBox.height + 2 * MAP_PAD, corner)} />
          </svg>
          <svg className="drawing-viewport__map-sketch" viewBox={`0 0 ${drawing.width} ${drawing.height}`} preserveAspectRatio="none">
            {map.sketch.lines.map((line, index) => (
              <polyline key={`l${index}`} className="drawing-viewport__map-line" points={line.points.map((point) => `${point.x},${point.y}`).join(' ')} stroke={line.tone} />
            ))}
            {map.sketch.boxes.map((item, index) => (
              <rect key={`b${index}`} className="drawing-viewport__map-box" x={item.box.x} y={item.box.y} width={item.box.width} height={item.box.height} fill={item.tone} />
            ))}
            <rect className="drawing-viewport__map-view" x={mapWindow.x} y={mapWindow.y} width={mapWindow.width} height={mapWindow.height} />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
