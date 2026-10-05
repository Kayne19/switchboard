import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';

// The viewport an HTML list is read in when it outgrows its slot (a to-do
// list, an inbox, an agenda, a forecast's days): the list scrolls inside
// it, up and down only, and on each edge it continues past the viewport
// draws what DrawingViewport draws for a drawing, in the same classes so
// the two read as one instrument: a fade as the edge's rows run under it,
// the dashed cut line, and a count of the items wholly past that edge with
// a chevron pointing there (a tap turns a page that way). A list that fits
// has none of them and does not scroll.
//
// Items are the elements under the scroll that carry `data-item` (the name
// a note uses for them, `app/noteItems.ts`); anything else in the list (a
// group heading, a day rule) is not counted. They are counted by their
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

/** A box along the scroll axis, in one coordinate space. */
export interface Extent {
  top: number;
  bottom: number;
}

// Half a pixel either way is the edge itself, not past it.
const EDGE = 0.5;

/** How many items lie wholly past each edge of `view`. */
export function countPast(items: Extent[], view: Extent): ListPast {
  let above = 0;
  let below = 0;
  for (const item of items) {
    if (item.bottom <= view.top + EDGE) above += 1;
    else if (item.top >= view.bottom - EDGE) below += 1;
  }
  return { above, below };
}

/**
 * Where the scroll rests to show `lead` (in content coordinates): where it
 * stands already when the lead is wholly in view, else with the lead a
 * quarter of the way down, or at the top when it is taller than that room.
 */
export function leadScrollTop(lead: Extent, scrollTop: number, viewHeight: number, contentHeight: number): number {
  const max = Math.max(0, contentHeight - viewHeight);
  if (lead.top >= scrollTop - EDGE && lead.bottom <= scrollTop + viewHeight + EDGE) return scrollTop;
  const above = lead.bottom - lead.top > viewHeight * 0.75 ? 0 : Math.round(viewHeight * 0.25);
  return Math.max(0, Math.min(max, Math.round(lead.top - above)));
}

/** How a count names its items: a singular and a plural, or a function of the count. */
export type ListNoun = readonly [string, string] | ((count: number) => string);

function nounFor(noun: ListNoun, count: number): string {
  if (typeof noun === 'function') return noun(count);
  return count === 1 ? noun[0] : noun[1];
}

// The deepest a fade reaches, as a share of the view, and its least depth.
const FADE_SHARE = 0.18;
const FADE_MAX = 36;
const FADE_MIN = 18;
// A page is the view less a row's worth, so the row at the edge stays in sight.
const PAGE_SHARE = 0.85;

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

interface ListViewportProps {
  children: ReactNode;
  /** How the counts name the items: `['TASK', 'TASKS']`, or `(n) => ...`. */
  noun: ListNoun;
  /** The `data-item` of the item to open on; absent, an element marked `data-lead`, if any. */
  lead?: string;
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
}

export function ListViewport({ children, noun, lead, head, className, scrollClassName, scrollRef: givenRef, label }: ListViewportProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const scrollRef = givenRef ?? ownRef;
  const [past, setPast] = useState<ListPast>({ above: 0, below: 0 });
  const [scrolls, setScrolls] = useState(false);
  const [viewHeight, setViewHeight] = useState(0);

  // What the edges say, from where the reader stands. Read on scroll at
  // most once a frame, and whenever the list or its box changes.
  const frame = useRef(0);
  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const items = Array.from(element.querySelectorAll<HTMLElement>('[data-item]')).map((item) => {
      const rect = item.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const next = element.scrollHeight > element.clientHeight + 1 ? countPast(items, { top: box.top, bottom: box.top + element.clientHeight }) : { above: 0, below: 0 };
    setPast((current) => (current.above === next.above && current.below === next.below ? current : next));
    setScrolls(element.scrollHeight > element.clientHeight + 1);
    setViewHeight(element.clientHeight);
  }, [scrollRef]);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const resized = new ResizeObserver(() => measure());
    const watch = () => {
      resized.disconnect();
      resized.observe(element);
      for (const child of Array.from(element.children)) resized.observe(child);
      measure();
    };
    const changed = new MutationObserver(watch);
    changed.observe(element, { childList: true, subtree: true, characterData: true });
    watch();
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
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
    const top = rect.top - box.top + element.scrollTop;
    element.scrollTop = leadScrollTop({ top, bottom: top + rect.height }, element.scrollTop, element.clientHeight, element.scrollHeight);
  });

  // Keys that scroll a focused list scroll it; they do not reach the
  // surface around it, which would take Space as "expand".
  const keepScrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(event.key)) event.stopPropagation();
  };
  // A tap on an edge's count turns a page that way; it does not expand the
  // object around the list.
  const page = (direction: -1 | 1) => (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const element = scrollRef.current;
    if (!element) return;
    element.scrollBy({ top: direction * Math.max(1, Math.round(element.clientHeight * PAGE_SHARE)), behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  const fade = Math.round(Math.max(FADE_MIN, Math.min(FADE_MAX, viewHeight * FADE_SHARE)));
  const edge = (side: 'top' | 'bottom', count: number) =>
    count > 0 ? (
      <>
        <div className={`drawing-viewport__more drawing-viewport__more--${side}`} style={{ height: `${fade}px` }} aria-hidden="true" />
        <div className={`drawing-viewport__rail drawing-viewport__rail--${side}`} aria-hidden="true" />
        <div className={`drawing-viewport__rim drawing-viewport__rim--${side} list-viewport__rim`} onClick={page(side === 'top' ? -1 : 1)} aria-hidden="true" data-count={count}>
          <span className="drawing-viewport__rim-text">{`${count} ${nounFor(noun, count)}`}</span>
          <svg className="drawing-viewport__chevron" viewBox="0 0 8 6" aria-hidden="true">
            <path d="M 4 0 L 8 6 L 0 6 Z" />
          </svg>
        </div>
      </>
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
          onKeyDown={scrolls ? keepScrollKeys : undefined}
        >
          {children}
        </div>
        {edge('top', past.above)}
        {edge('bottom', past.below)}
      </div>
    </div>
  );
}
