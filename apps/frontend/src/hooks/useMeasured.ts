import { useLayoutEffect, useState, type DependencyList } from 'react';
import { flushSync } from 'react-dom';
import { watchElement } from './watchElement';

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
 * - Each report of the element's observers (watchElement) reads it again
 *   and commits a changed value at once (flushSync), before the frame it
 *   reports is painted. Left to React's schedule, a size was drawn a frame
 *   late at best, and on a loaded WebKit half a second late (#333).
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
    // The first read is the layout effect's own; the observers' are
    // committed at once, before the frame they report is painted.
    let observing = false;
    const stop = watchElement(element, () => (observing ? flushSync(take) : take()), { children, changes });
    observing = true;
    return stop;
    // `deps` are the caller's: what target and read depend on.
  }, deps);
  return held;
}
