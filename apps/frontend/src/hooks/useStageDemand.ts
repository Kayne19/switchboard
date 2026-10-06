import { createContext, createElement, useContext, useEffect, useId, useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { StageNeed } from '../app/stageFold';
import type { Size } from '../primitives/geometry';

// What a primary's content asks of the stage (docs/visual-channel.md, "A
// primary that outgrows its slot"). A primitive whose content may outgrow
// its viewport -- a drawing, a table, a code pane, a document, a figure, a
// bar chart, a plan -- says how much taller than its viewport it would have
// to be to be read whole at its readable size, in CSS pixels: more than zero
// when it overflows, zero or less (the room it leaves) when it fits. The
// shell gives the primary's surface a listener, and on a stage whose rail
// stands under the slot folds the rail away while the primary needs the
// height (SceneShell). Anywhere else (an aux cell, the focus layer) there is
// no listener: nothing is measured or said. Saying renders nothing: a
// primitive is drawn as it would be anyway.

/** Hears, for each reporting primitive in the primary's surface, how much height it lacks past its viewport's; `null` once it has nothing to ask (it is gone, or its content asks for nothing). */
export type StageDemandListener = (key: string, need: StageNeed | null) => void;

export const StageDemandContext = createContext<StageDemandListener | null>(null);

/**
 * Passes the primary's listener on to `children` once `measured`, and none
 * before. A primitive that lays itself out for its box (a calendar's grid
 * or agenda, a forecast's arrangement, timers in cells or rows) draws a
 * stand-in until it has measured the box, and what the stand-in lacks is
 * no word on the drawing that will stand there: heard, it could fold the
 * rail for content that is never drawn, and the drawing that is would then
 * first speak on the stage, with no measure from the shared layout to be
 * weighed against (stageFold.ts).
 */
export function MeasuredStageDemand({ measured, children }: { measured: boolean; children: ReactNode }): ReactElement {
  const listener = useContext(StageDemandContext);
  return createElement(StageDemandContext.Provider, { value: measured ? listener : null }, children);
}

// Whole pixels: sub-pixel churn is not a change of mind.
const need = (excess: number, viewport: number, relaid?: (height: number) => number): StageNeed => ({
  excess: Math.round(excess),
  viewport: Math.round(viewport),
  ...(relaid ? { relaid } : {}),
});

/**
 * Measures an element whenever it is resized, and, as asked, whenever one
 * of its children is or what it holds changes. Returns the disconnect.
 */
export function watchElement(element: Element, measure: () => void, { children = false, changes = false }: { children?: boolean; changes?: boolean } = {}): () => void {
  const resized = new ResizeObserver(() => measure());
  const watch = () => {
    resized.disconnect();
    resized.observe(element);
    if (children) for (const child of Array.from(element.children)) resized.observe(child);
    measure();
  };
  const changed = changes || children ? new MutationObserver(watch) : null;
  changed?.observe(element, { childList: true, subtree: changes, characterData: changes });
  watch();
  return () => {
    resized.disconnect();
    changed?.disconnect();
  };
}

/**
 * Says how much taller than a box (`ref`) a content needs it to be, given
 * the least height the content is read whole in (`least`, CSS pixels, or
 * worked out from the box): measured whenever the box is resized or the
 * content's need changes. `null` is a content that asks for nothing; a
 * function may answer `undefined` while it cannot tell, and what it said
 * last stands. `relaid`, for a content laid out again for the box's
 * height: the least height it asks for when laid out for a box that tall
 * (StageNeed `relaid`).
 */
export function useLeastHeight(
  ref: RefObject<HTMLElement | null>,
  least: number | ((box: Size) => number | null | undefined) | null,
  relaid?: (height: number) => number,
): void {
  const listener = useContext(StageDemandContext);
  const key = useId();
  const wanted = useRef(least);
  const relayout = useRef(relaid);
  const tell = useRef<() => void>(() => {});
  // Said again when either changes: what a content laid out afresh would
  // ask in another box may change while what it asks in this one does not.
  useEffect(() => {
    wanted.current = least;
    relayout.current = relaid;
    tell.current();
  }, [least, relaid]);
  useEffect(() => {
    const element = ref.current;
    if (!listener || !element) return undefined;
    tell.current = () => {
      const height = element.offsetHeight;
      if (!(height > 0)) return;
      const current = wanted.current;
      const content = typeof current === 'function' ? current({ width: element.offsetWidth, height }) : current;
      if (content === undefined) return;
      listener(key, content === null ? null : need(content - height, height, relayout.current));
    };
    const stop = watchElement(element, () => tell.current());
    return () => {
      stop();
      tell.current = () => {};
      listener(key, null);
    };
  }, [listener, ref, key]);
}

/**
 * How much a box is drawn scaled on screen: a shared-layout animation (focus
 * opening) scales the box it moves, and its rects with it, while its layout
 * sizes (clientHeight, offsetHeight) stay as laid out. Measures from the two
 * are brought to one scale by it.
 */
export function drawnScale(rectHeight: number, offsetHeight: number): number {
  return offsetHeight > 0 && rectHeight > 0 ? rectHeight / offsetHeight : 1;
}

/**
 * How tall a scroll region's content is, in its own layout pixels: what it
 * scrolls through when it overflows, and otherwise down to the end of its
 * last child and its padding, so a region with room to spare says how much.
 * A box in a shared-layout animation is scaled on screen; its offset height
 * is not, and the measures are brought back to it.
 */
export function scrollContentHeight(element: HTMLElement): number {
  if (element.scrollHeight > element.clientHeight + 1) return element.scrollHeight;
  const box = element.getBoundingClientRect();
  const k = drawnScale(box.height, element.offsetHeight);
  const style = getComputedStyle(element);
  const top = box.top + (parseFloat(style.borderTopWidth) || 0) * k;
  let bottom = (parseFloat(style.paddingTop) || 0) * k;
  for (const child of Array.from(element.children)) {
    const rect = child.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue;
    const margin = parseFloat(getComputedStyle(child).marginBottom) || 0;
    bottom = Math.max(bottom, rect.bottom - top + margin * k);
  }
  return bottom / k + element.scrollTop + (parseFloat(style.paddingBottom) || 0);
}

/**
 * Says how much taller than its box a scroll region's content is, measured
 * whenever the region or what it holds is resized or changed.
 */
export function useScrollDemand(ref: RefObject<HTMLElement | null>): void {
  const listener = useContext(StageDemandContext);
  const key = useId();
  useEffect(() => {
    const element = ref.current;
    if (!listener || !element) return undefined;
    const stop = watchElement(
      element,
      () => {
        if (element.clientHeight > 0) listener(key, need(scrollContentHeight(element) - element.clientHeight, element.clientHeight));
      },
      { children: true, changes: true },
    );
    return () => {
      stop();
      listener(key, null);
    };
  }, [listener, ref, key]);
}
