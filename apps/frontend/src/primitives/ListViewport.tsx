import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { prefersReducedMotion } from './reducedMotion';
import { PAGE_SHARE, scrollMove, type ScrollMove } from './drawingScroll';
import { drawnScale, watchElement } from '../hooks/watchElement';

// The viewport an HTML list is read in when it outgrows its slot (a to-do
// list, an inbox, an agenda, a forecast's days, a table's rows, source, a
// document's body): the list scrolls inside it, up and down only (sideways
// too where the content asks), and takes the keys every scroller takes. It
// draws nothing on the edges it continues past -- no rim, and no fade over
// the rows there (#177); it opens on its lead clear of them (`leadBand`).
// A list that fits does not scroll.
//
// It opens on its lead, once per shape (the lead, the item count, the
// viewport's height): the item `lead` names, else an element marked
// `data-lead` (a calendar's now line), brought into view a little below
// the top. An update that keeps the shape keeps the reader's place.

/** A box along the scroll axis, in one coordinate space. */
export interface Extent {
  top: number;
  bottom: number;
}

// Half a pixel either way is the edge itself, not past it.
const EDGE = 0.5;

/**
 * Where the scroll rests to show `lead` (in content coordinates): where it
 * stands already when the lead is wholly in the clear part of the view,
 * else with the lead a quarter of the way down, or at the top when it is
 * taller than that room. The clear part leaves out the band (`band`,
 * `leadBand`) at each edge the list continues past: a lead the edge cuts
 * is not in view, and one resting against the cut had its NOTE badge
 * clipped by the frame.
 */
export function leadScrollTop(lead: Extent, scrollTop: number, viewHeight: number, contentHeight: number, band = 0): number {
  const max = Math.max(0, contentHeight - viewHeight);
  const top = scrollTop + (scrollTop > EDGE ? band : 0);
  const bottom = scrollTop + viewHeight - (scrollTop < max - EDGE ? band : 0);
  if (lead.top >= top - EDGE && lead.bottom <= bottom + EDGE) return scrollTop;
  const above = lead.bottom - lead.top > viewHeight * 0.75 ? 0 : Math.round(viewHeight * 0.25);
  return Math.max(0, Math.min(max, Math.round(lead.top - above)));
}

/** The room a list opening on its lead keeps at an edge it continues past, for a view `viewHeight` tall. */
export function leadBand(viewHeight: number): number {
  return Math.round(Math.max(BAND_MIN, Math.min(BAND_MAX, viewHeight * BAND_SHARE)));
}

// The deepest that band reaches, as a share of the view, and its least depth.
const BAND_SHARE = 0.18;
const BAND_MAX = 36;
const BAND_MIN = 18;
// An arrow moves a list a line.
const LINE = 40;

/** A page of a list whose view is `viewHeight` tall: the drawing's page (PAGE_SHARE). */
const pageLength = (viewHeight: number) => Math.max(1, Math.round(viewHeight * PAGE_SHARE));

/**
 * Where a scroll key (drawingScroll `scrollMove`, the rule every scroller
 * keeps) moves a list's scroll to: a page, a line, or an end, no further
 * than either end; null for a key the list does not take. `pinned` is the
 * band at the view's top the rows pass under (a table's header): a page is
 * a page of what shows below it.
 */
export function keyScrollTop(key: string, shift: boolean, scrollTop: number, viewHeight: number, contentHeight: number, pinned = 0): number | null {
  return keyScroll(scrollMove(key, shift, false), scrollTop, viewHeight, contentHeight, pinned);
}

/**
 * Where a scroll key moves a pane that scrolls only across (a wide table
 * on a phone, source with long lines): the same rule along its width, as a
 * drawing that scrolls only across takes it (`scrollMove`, across): the
 * arrow left or right a line, Space and Page Down a page on, Shift+Space
 * and Page Up a page back, Home and End to either side; null for a key it
 * does not take (the arrows up and down, Enter).
 */
export function keyScrollLeft(key: string, shift: boolean, scrollLeft: number, viewWidth: number, contentWidth: number): number | null {
  return keyScroll(scrollMove(key, shift, true), scrollLeft, viewWidth, contentWidth, 0);
}

// A move along one axis: a page of the view less what is pinned over it, a line, or to an end.
function keyScroll(move: ScrollMove | null, position: number, view: number, content: number, pinned: number): number | null {
  if (!move) return null;
  const max = Math.max(0, content - view);
  const by = move.kind === 'page' ? pageLength(view - pinned) : move.kind === 'step' ? LINE : max;
  return Math.max(0, Math.min(max, position + move.direction * by));
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

interface ListViewportProps {
  children: ReactNode;
  /** The `data-item` of the item to open on; absent, an element marked `data-lead`, if any; null, none (a row of objects, whose leads are their own). */
  lead?: string | null;
  /** Pinned above the scroll inside the same frame: a list's header, a calendar's day row. */
  head?: ReactNode;
  /** The viewport's own class, beside `list-viewport`. */
  className?: string;
  /** The scroll element's class, beside `list-viewport__scroll`: the primitive's padding and type. */
  scrollClassName?: string;
  /** The scroll element, for a primitive that measures it. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** The accessible name of the scroll region. */
  label?: string;
  /**
   * The band at the top of the scroll that the rows pass under (a table's
   * sticky header), by a selector inside it: the top edge and a page start
   * below it. The lead (`lead`) does not reckon with it: no list with a
   * band has a lead.
   */
  pinned?: string;
}

export function ListViewport({ children, lead, head, className, scrollClassName, scrollRef: givenRef, label, pinned }: ListViewportProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const scrollRef = givenRef ?? ownRef;
  const [scrolls, setScrolls] = useState(false);
  // A pane that scrolls across (a table's, source's or document's) may
  // overflow only sideways (long lines, a wide table on a phone): it is a
  // tab stop too, and takes the scroll keys across, so a reader without a
  // pointer can scroll it, and Space pages it rather than reaching the
  // surface.
  const [across, setAcross] = useState(false);
  const [pinnedDepth, setPinnedDepth] = useState(0);

  // Whether it scrolls, which way, and how deep the band pinned over it
  // is: read whenever the list or its box changes. Nothing here moves with
  // the scroll.
  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // The box's rect is on screen, scaled with it while a focus opens or a
    // cell of the aux row settles; the pinned band's depth is brought back
    // to the list's own pixels, so a depth read mid-animation is the depth
    // at rest. Nothing reads it again when such an animation ends.
    const box = element.getBoundingClientRect();
    const k = drawnScale(box.height, element.offsetHeight);
    const band = pinned ? element.querySelector<HTMLElement>(pinned) : null;
    const depth = band ? band.getBoundingClientRect().height / k : 0;
    setScrolls(element.scrollHeight > element.clientHeight + 1);
    // Across only where the pane can scroll that way: a list clips what
    // sticks out sideways (overflow-x: hidden), which scrollWidth still counts.
    setAcross(element.scrollWidth > element.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(element).overflowX));
    setPinnedDepth(depth);
  }, [scrollRef, pinned]);

  useEffect(() => {
    const element = scrollRef.current;
    return element ? watchElement(element, measure, { children: true, changes: true }) : undefined;
  }, [scrollRef, measure]);

  // Opens on the lead, once per shape.
  const led = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const shape = `${lead ?? ''}|${element.querySelectorAll('[data-item]').length}|${Math.round(element.clientHeight)}`;
    if (led.current === shape || lead === null) return;
    led.current = shape;
    const target = lead !== undefined
      ? element.querySelector<HTMLElement>(`[data-item="${cssEscape(lead)}"]`)
      : element.querySelector<HTMLElement>('[data-lead]');
    if (!target) return;
    const box = element.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const k = drawnScale(box.height, element.offsetHeight);
    const top = (rect.top - box.top) / k + element.scrollTop;
    element.scrollTop = leadScrollTop({ top, bottom: top + rect.height / k }, element.scrollTop, element.clientHeight, element.scrollHeight, leadBand(element.clientHeight));
  });

  // The keys that scroll a focused list scroll it here, and each one it
  // takes is marked handled (FocusableSurface's rule: a child marks an
  // event with preventDefault and never stops it), so the surface around it
  // leaves Space alone rather than expanding the object, and Enter, which
  // the list does not take, still expands it. They move it down, or, in a
  // pane that scrolls only across, across (a drawing's rule).
  const scrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!element || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const sideways = !scrolls;
    const to = sideways
      ? keyScrollLeft(event.key, event.shiftKey, element.scrollLeft, element.clientWidth, element.scrollWidth)
      : keyScrollTop(event.key, event.shiftKey, element.scrollTop, element.clientHeight, element.scrollHeight, pinnedDepth);
    if (to === null) return;
    event.preventDefault();
    element.scrollTo({ [sideways ? 'left' : 'top']: to, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };
  return (
    <div className={`list-viewport${scrolls ? ' list-viewport--scrolling' : ''}${className ? ` ${className}` : ''}`}>
      {head ? <div className="list-viewport__head">{head}</div> : null}
      <div className="list-viewport__port">
        <div
          ref={scrollRef}
          className={`list-viewport__scroll${scrollClassName ? ` ${scrollClassName}` : ''}`}
          tabIndex={scrolls || across ? 0 : undefined}
          aria-label={label}
          role={label ? 'region' : undefined}
          onKeyDown={scrolls || across ? scrollKeys : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
