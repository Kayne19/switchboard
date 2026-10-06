import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useOncePerFrame } from '../hooks/useOncePerFrame';
import { rimCount, type Noun } from './countText';
import { prefersReducedMotion } from './reducedMotion';
import { ScrollRim } from './ScrollRim';
import { PAGE_SHARE, scrollMove } from './drawingScroll';
import { drawnScale, useLeastHeight, useScrollDemand, watchElement } from '../hooks/useStageDemand';

// The viewport an HTML list is read in when it outgrows its slot (a to-do
// list, an inbox, an agenda, a forecast's days): the list scrolls inside
// it, up and down only, and on each edge it continues past the viewport
// draws the rim DrawingViewport draws for a drawing (ScrollRim), so the
// two read as one instrument: a fade as the edge's rows run under it,
// the dashed cut line, and a count of the items wholly past that edge with
// a chevron pointing there (a tap turns a page that way). A list that fits
// has none of them and does not scroll.
//
// Items are the elements under the scroll that carry `data-item` (the name
// a note uses for them, `app/noteItems.ts`), or those `countSelector`
// picks where only some of them are what the list is a list of; anything
// else in the list (a group heading, a day rule) is not counted. They are counted by their
// boxes against the scroll's edges, whatever their layout: rows, a time
// grid with several to a row, cards.
//
// It opens on its lead, once per shape (the lead, the item count, the
// viewport's height): the item `lead` names, else an element marked
// `data-lead` (a calendar's now line), brought into view a little below
// the top. An update that keeps the shape keeps the reader's place.

/** What lies past each edge of a list's view, counted in whole items. */
export interface ListPast {
  above: number;
  below: number;
}

/**
 * The edges a list continues past: more of it than a sliver lies that way.
 * An edge is marked even where no item lies past it (a forecast's
 * conditions above its days): the count names what it can, and the edge
 * still says the list goes on.
 */
export function continuesPast(scrollTop: number, viewHeight: number, contentHeight: number): { top: boolean; bottom: boolean } {
  return { top: scrollTop > SLIVER, bottom: contentHeight - viewHeight - scrollTop > SLIVER };
}

/** A box along the scroll axis, in one coordinate space. */
export interface Extent {
  top: number;
  bottom: number;
}

// Half a pixel either way is the edge itself, not past it.
const EDGE = 0.5;
// An item with no more of it in view than this is past the edge: what
// shows of it is its padding, not its words. The least of a few pixels and
// a share of its height.
const SLIVER = 16;
const SLIVER_SHARE = 0.4;

/** How much of an item may show in the view while it still counts as past the edge. */
const sliver = (item: Extent) => Math.max(EDGE, Math.min(SLIVER, (item.bottom - item.top) * SLIVER_SHARE));

/** How many items lie past each edge of `view`: wholly, or with only a sliver of them in view. */
export function countPast(items: Extent[], view: Extent): ListPast {
  let above = 0;
  let below = 0;
  for (const item of items) {
    if (item.bottom <= view.top + sliver(item)) above += 1;
    else if (item.top >= view.bottom - sliver(item)) below += 1;
  }
  return { above, below };
}

/**
 * Where the scroll rests to show `lead` (in content coordinates): where it
 * stands already when the lead is wholly in the clear part of the view,
 * else with the lead a quarter of the way down, or at the top when it is
 * taller than that room. The clear part leaves out the band (`band`, the
 * fade's depth) at each edge the list continues past, where the fade and
 * the count lie over the rows: a lead under them is not in view.
 */
export function leadScrollTop(lead: Extent, scrollTop: number, viewHeight: number, contentHeight: number, band = 0): number {
  const max = Math.max(0, contentHeight - viewHeight);
  const top = scrollTop + (scrollTop > EDGE ? band : 0);
  const bottom = scrollTop + viewHeight - (scrollTop < max - EDGE ? band : 0);
  if (lead.top >= top - EDGE && lead.bottom <= bottom + EDGE) return scrollTop;
  const above = lead.bottom - lead.top > viewHeight * 0.75 ? 0 : Math.round(viewHeight * 0.25);
  return Math.max(0, Math.min(max, Math.round(lead.top - above)));
}

/** The depth of the fade at an edge a list continues past, for a view `viewHeight` tall. */
export function fadeDepth(viewHeight: number): number {
  return Math.round(Math.max(FADE_MIN, Math.min(FADE_MAX, viewHeight * FADE_SHARE)));
}

// The deepest a fade reaches, as a share of the view, and its least depth.
const FADE_SHARE = 0.18;
const FADE_MAX = 36;
const FADE_MIN = 18;
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
  const move = scrollMove(key, shift, false);
  if (!move) return null;
  const max = Math.max(0, contentHeight - viewHeight);
  const by = move.kind === 'page' ? pageLength(viewHeight - pinned) : move.kind === 'step' ? LINE : max;
  return Math.max(0, Math.min(max, scrollTop + move.direction * by));
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

interface ListViewportProps {
  children: ReactNode;
  /** How the counts name the items: `['TASK', 'TASKS']`. */
  noun: Noun;
  /** The `data-item` of the item to open on; absent, an element marked `data-lead`, if any. */
  lead?: string;
  /** Which items the counts count, when not every `data-item` is one (a forecast counts its days, not its hours). */
  countSelector?: string;
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
   * sticky header), by a selector inside it: the counts, the top edge and a
   * page start below it.
   */
  pinned?: string;
  /**
   * The least height (CSS px) the content reads whole in, for content that
   * grows to fill whatever view it is given (a calendar's hour grid): the
   * stage is asked for that, not for what the content happens to measure.
   * Absent, the stage is asked for the scroll content's own height.
   */
  least?: number | null;
}

export function ListViewport({ children, noun, lead, countSelector = '[data-item]', head, className, scrollClassName, scrollRef: givenRef, label, least, pinned }: ListViewportProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const scrollRef = givenRef ?? ownRef;
  // A primary list that outgrows its slot says how much height it lacks,
  // and a stage whose rail stands under the slot gives it the height
  // (useStageDemand): by its scroll content, or by its least height.
  const noRef = useRef<HTMLDivElement>(null);
  useScrollDemand(least === undefined ? scrollRef : noRef);
  useLeastHeight(least === undefined ? noRef : scrollRef, least ?? null);
  const [past, setPast] = useState<ListPast & { top: boolean; bottom: boolean }>({ above: 0, below: 0, top: false, bottom: false });
  const [scrolls, setScrolls] = useState(false);
  const [viewHeight, setViewHeight] = useState(0);
  const [pinnedDepth, setPinnedDepth] = useState(0);

  // What the edges say, from where the reader stands. Read on scroll at
  // most once a frame, and whenever the list or its box changes.
  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // The rows' rects and the box's are on screen, scaled with it while a
    // focus opens; the view's height is brought to that scale, so the
    // counts are right mid-animation as at rest.
    const box = element.getBoundingClientRect();
    const k = drawnScale(box.height, element.offsetHeight);
    const items = Array.from(element.querySelectorAll<HTMLElement>(countSelector)).map((item) => {
      const rect = item.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const band = pinned ? element.querySelector<HTMLElement>(pinned) : null;
    const depth = band ? band.getBoundingClientRect().height / k : 0;
    const overflows = element.scrollHeight > element.clientHeight + 1;
    const counts = overflows ? countPast(items, { top: box.top + depth * k, bottom: box.top + element.clientHeight * k }) : { above: 0, below: 0 };
    const goes = overflows ? continuesPast(element.scrollTop, element.clientHeight, element.scrollHeight) : { top: false, bottom: false };
    const next = { ...counts, top: goes.top || counts.above > 0, bottom: goes.bottom || counts.below > 0 };
    setPast((current) =>
      current.above === next.above && current.below === next.below && current.top === next.top && current.bottom === next.bottom ? current : next,
    );
    setScrolls(element.scrollHeight > element.clientHeight + 1);
    setViewHeight(element.clientHeight);
    setPinnedDepth(depth);
  }, [scrollRef, countSelector, pinned]);
  const onScroll = useOncePerFrame(measure);

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
    if (led.current === shape) return;
    led.current = shape;
    const target = lead !== undefined
      ? element.querySelector<HTMLElement>(`[data-item="${cssEscape(lead)}"]`)
      : element.querySelector<HTMLElement>('[data-lead]');
    if (!target) return;
    const box = element.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const k = drawnScale(box.height, element.offsetHeight);
    const top = (rect.top - box.top) / k + element.scrollTop;
    element.scrollTop = leadScrollTop({ top, bottom: top + rect.height / k }, element.scrollTop, element.clientHeight, element.scrollHeight, fadeDepth(element.clientHeight));
  });

  // The keys that scroll a focused list scroll it here, and each one it
  // takes is marked handled (FocusableSurface's rule: a child marks an
  // event with preventDefault and never stops it), so the surface around it
  // leaves Space alone rather than expanding the object, and Enter, which
  // the list does not take, still expands it.
  const scrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!element || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const top = keyScrollTop(event.key, event.shiftKey, element.scrollTop, element.clientHeight, element.scrollHeight, pinnedDepth);
    if (top === null) return;
    event.preventDefault();
    element.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };
  // A tap on an edge's count turns a page that way (ScrollRim marks it handled).
  const page = (direction: -1 | 1) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollBy({ top: direction * pageLength(element.clientHeight - pinnedDepth), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  const fade = fadeDepth(viewHeight - pinnedDepth);
  // An edge the list continues past: the fade, the cut line, and the count
  // of the items that lie that way, or MORE where none of them does.
  const edge = (side: 'top' | 'bottom', continues: boolean, count: number) =>
    continues ? (
      <ScrollRim
        side={side}
        fade={fade}
        text={count > 0 ? rimCount(count, noun) : 'MORE'}
        onPage={() => page(side === 'top' ? -1 : 1)}
        inset={pinned ? pinnedDepth : undefined}
        count={count}
      />
    ) : null;

  return (
    <div className={`list-viewport${scrolls ? ' list-viewport--scrolling' : ''}${className ? ` ${className}` : ''}`}>
      {head ? <div className="list-viewport__head">{head}</div> : null}
      <div className="list-viewport__port">
        <div
          ref={scrollRef}
          className={`list-viewport__scroll${scrollClassName ? ` ${scrollClassName}` : ''}`}
          tabIndex={scrolls ? 0 : undefined}
          aria-label={label}
          role={label ? 'region' : undefined}
          onScroll={onScroll}
          onKeyDown={scrolls ? scrollKeys : undefined}
        >
          {children}
        </div>
        {edge('top', past.top, past.above)}
        {edge('bottom', past.bottom, past.below)}
      </div>
    </div>
  );
}
