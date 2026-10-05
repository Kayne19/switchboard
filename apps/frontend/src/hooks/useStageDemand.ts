import { createContext, useContext, useEffect, useId, useRef, type RefObject } from 'react';

// What a primary's content asks of the stage (docs/visual-channel.md, "A
// primary that outgrows its slot"). A primitive whose content may outgrow
// its viewport -- a drawing, a table, a code pane, a document -- says how
// much taller than its viewport it would have to be to be read whole at its
// readable size, in CSS pixels: more than zero when it overflows, zero or
// less (the room it leaves) when it fits. The shell gives the primary slot a
// listener, and on a stage whose rail stands under the slot folds the rail
// away while the primary needs the height (SceneShell). Anywhere else (an
// aux cell, the focus layer) there is no listener: nothing is measured or
// said. Saying renders nothing: a primitive is drawn as it would be anyway.

/** Hears, for each reporting primitive in the primary slot, how much height it lacks; `null` once it has nothing to say. */
export type StageDemandListener = (key: string, excess: number | null) => void;

export const StageDemandContext = createContext<StageDemandListener | null>(null);

// A whole pixel either way: sub-pixel churn is not a change of mind.
const whole = (excess: number | null) => (excess === null || !Number.isFinite(excess) ? null : Math.round(excess));

/** Says how much taller than its viewport a primitive's content asks to be (CSS pixels), or `null` while it cannot tell. */
export function useStageDemand(excess: number | null): void {
  const listener = useContext(StageDemandContext);
  const key = useId();
  const said = whole(excess);
  useEffect(() => {
    listener?.(key, said);
  }, [listener, key, said]);
  useEffect(() => () => listener?.(key, null), [listener, key]);
}

/**
 * Says how much taller than a box (`ref`) a content needs it to be, given
 * the least height the content is read whole in (`least`, CSS pixels):
 * measured whenever the box is resized or the content's need changes.
 */
export function useLeastHeight(ref: RefObject<HTMLElement | null>, least: number | null): void {
  const listener = useContext(StageDemandContext);
  const key = useId();
  const need = useRef(least);
  need.current = least;
  const tell = useRef<() => void>(() => {});
  useEffect(() => {
    const element = ref.current;
    if (!listener || !element) return undefined;
    tell.current = () => {
      const height = element.offsetHeight;
      listener(key, height > 0 && need.current !== null ? whole(need.current - height) : null);
    };
    tell.current();
    const observer = new ResizeObserver(() => tell.current());
    observer.observe(element);
    return () => {
      observer.disconnect();
      tell.current = () => {};
      listener(key, null);
    };
  }, [listener, ref, key]);
  useEffect(() => tell.current(), [least]);
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
  const k = element.offsetHeight > 0 && box.height > 0 ? box.height / element.offsetHeight : 1;
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
 * Says how much taller than its box a scroll region's content is
 * (`useStageDemand`), measured whenever the region or what it holds is
 * resized or changed.
 */
export function useScrollDemand(ref: RefObject<HTMLElement | null>): void {
  const listener = useContext(StageDemandContext);
  const key = useId();
  useEffect(() => {
    const element = ref.current;
    if (!listener || !element) return undefined;
    const measure = () => listener(key, element.clientHeight > 0 ? whole(scrollContentHeight(element) - element.clientHeight) : null);
    const resized = new ResizeObserver(measure);
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
      listener(key, null);
    };
  }, [listener, ref, key]);
}
