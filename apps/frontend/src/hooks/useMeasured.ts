// What layout gives: a value read from it and held for render (useMeasured),
// and how much a box in a shared-layout animation is drawn scaled
// (drawnScale).
import { useLayoutEffect, useState, type DependencyList } from 'react';
import { flushSync } from 'react-dom';

/** How a measured value is held and watched. */
export interface Measure<T> {
  /** The value before anything is measured. */
  initial: T;
  /** Whether a read is the value held: a report of it commits nothing. `Object.is` unless given. */
  same?: (held: T, next: T) => boolean;
  /** Read again when one of the element's children is resized or the children change. */
  children?: boolean;
  /** Read again when anything the element holds changes (its subtree, its text). */
  changes?: boolean;
}

/**
 * A value read from the layout, held for render: the one lifecycle every
 * size, overflow or position the page draws from goes through (#392).
 *
 * - On mount, and whenever `deps` change, `target` names the element and
 *   `read` reads it in a layout effect, so the first frame painted is drawn
 *   with the value, not without it.
 * - Each report of the element's observers reads it again and commits a
 *   changed value at once (flushSync), before the frame it reports is
 *   painted. Left to React's schedule, a size was drawn a frame late at
 *   best, and on a loaded WebKit half a second late (#333).
 * - A read that is the value held (`same`) commits nothing: every
 *   observe() reports once, and that render would be in the frame.
 * - Unmounting, or a change of `deps`, disconnects the observers, in one
 *   place. With no element to measure (`target` gives none), nothing is
 *   watched and the value held stands; a reader whose value means nothing
 *   then says so where it uses it.
 *
 * `target` and `read` are called from the effect: what they read beyond
 * refs goes in `deps`, as for any effect.
 */
export function useMeasured<E extends Element, T>(
  target: () => E | null | undefined,
  read: (element: E) => T,
  { initial, same = Object.is, children = false, changes = false }: Measure<T>,
  deps: DependencyList,
): T {
  const [held, setHeld] = useState(initial);
  useLayoutEffect(() => {
    const element = target();
    if (!element) return undefined;
    const take = () => {
      const next = read(element);
      setHeld((current) => (same(current, next) ? current : next));
    };
    // The first read is the layout effect's own, committed with it; the
    // observers' are committed at once, before the frame they report is
    // painted.
    take();
    return observe(element, () => flushSync(take), { children, changes });
    // `deps` are the caller's: what target and read depend on.
  }, deps);
  return held;
}

/**
 * Reports an element whenever it is resized, and, as asked, whenever one
 * of its children is or what it holds changes. Returns the disconnect.
 */
function observe(element: Element, report: () => void, { children, changes }: { children: boolean; changes: boolean }): () => void {
  const resized = new ResizeObserver(() => report());
  const watch = () => {
    resized.observe(element);
    if (children) for (const child of Array.from(element.children)) resized.observe(child);
  };
  // Children that come and go are watched afresh: the ones there now.
  const changed = changes || children
    ? new MutationObserver(() => {
        resized.disconnect();
        watch();
        report();
      })
    : null;
  changed?.observe(element, { childList: true, subtree: changes, characterData: changes });
  watch();
  return () => {
    resized.disconnect();
    changed?.disconnect();
  };
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
