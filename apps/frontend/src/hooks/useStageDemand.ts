import { createContext, useContext, useEffect, useId, useState, type RefObject } from 'react';

// What a primary's content asks of the stage (docs/visual-channel.md, "A
// primary that outgrows its slot"). A primitive whose content may outgrow
// its viewport -- a drawing, a table, a code pane, a document -- says how
// much taller than its viewport it would have to be to be read whole at its
// readable size, in CSS pixels: more than zero when it overflows, zero or
// less (the room it leaves) when it fits. The shell gives the primary slot a
// listener, and on a stage whose rail stands under the slot folds the rail
// away while the primary needs the height (SceneShell). Anywhere else (an
// aux cell, the focus layer) there is no listener and nothing is said.

/** Hears, for each reporting primitive in the primary slot, how much height it lacks; `null` once it has nothing to say. */
export type StageDemandListener = (key: string, excess: number | null) => void;

export const StageDemandContext = createContext<StageDemandListener | null>(null);

/** Says how much taller than its viewport a primitive's content asks to be (CSS pixels), or `null` while it cannot tell. */
export function useStageDemand(excess: number | null): void {
  const listener = useContext(StageDemandContext);
  const key = useId();
  // A whole pixel either way: sub-pixel churn is not a change of mind.
  const said = excess === null || !Number.isFinite(excess) ? null : Math.round(excess);
  useEffect(() => {
    listener?.(key, said);
  }, [listener, key, said]);
  useEffect(() => () => listener?.(key, null), [listener, key]);
}

/**
 * The layout height of a box whose content the stage hears about, measured
 * only where something listens (the primary slot): 0 anywhere else.
 */
export function useStageBoxHeight(ref: RefObject<HTMLElement | null>): number {
  const listener = useContext(StageDemandContext);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!listener || !element) return undefined;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [listener, ref]);
  return listener ? height : 0;
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
  const [excess, setExcess] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!listener || !element) return undefined;
    const measure = () => setExcess(element.clientHeight > 0 ? scrollContentHeight(element) - element.clientHeight : null);
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
    };
  }, [listener, ref]);
  useStageDemand(listener ? excess : null);
}
