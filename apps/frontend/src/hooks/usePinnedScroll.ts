import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// How far above its pin a log still counts as pinned: a fractional scroll
// offset, or a nudge of a pixel or two, must not unpin it.
const PIN_SLACK_PX = 8;

/**
 * Where a pinned log rests: at the start of the section being heard, so that
 * section sits at the top of the window and the caller reads it from the
 * words they are hearing (#178). The newest section is at least a box tall
 * (`.spoken-log-box` in the stylesheet), which is what lets that start reach
 * the top; where it is shorter than that, as in a log the stylesheet does not
 * size, the log rests at the bottom. The section is the element marked
 * `aria-current="true"`; a log that marks none (the debug page's panes and
 * raw log) rests at the bottom.
 */
function pinTop(element: HTMLElement): number {
  const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
  const current = element.querySelector<HTMLElement>('[aria-current="true"]');
  if (!current) return bottom;
  const start =
    current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
  return Math.max(0, Math.min(bottom, start));
}

/**
 * Keeps a scrolling log pinned to its newest section (#113, #178). While pinned, new
 * content and a resize keep it there. Scrolling up unpins it, so earlier
 * lines can be read while new ones arrive, and scrolling back down pins it
 * again. `content` is what the log renders; a change to it is new content.
 * With `enabled` false the surface is left where it is and its scrolling is
 * not read: a surface that is not a log, or a log the reader paused.
 * Every pin-to-bottom scroller in the tree, the page's and the debug
 * page's, is this hook (`apps/frontend/AGENTS.md`).
 */
export function usePinnedScroll<T extends HTMLElement>(content: unknown, enabled = true) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element || !enabledRef.current) return;
    pinned.current = element.scrollTop >= pinTop(element) - PIN_SLACK_PX;
  }, []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element && enabled && pinned.current) element.scrollTop = pinTop(element);
  }, [content, enabled]);

  // The card growing or the text reflowing moves the pin without new
  // content; a pinned log follows it.
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (enabledRef.current && pinned.current) element.scrollTop = pinTop(element);
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return { ref, onScroll };
}
