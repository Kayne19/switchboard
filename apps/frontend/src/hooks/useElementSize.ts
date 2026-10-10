import { useLayoutEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { Size } from '../primitives/geometry';

// The element's layout size. An HTML element is read through its offset
// size, which a transform does not change: a shared-layout animation scales
// the box it moves, and a size read mid-flight would lay a drawing out for
// a frame it never settles in. It is read in a layout effect, so the first
// frame painted is drawn at the size read, not at none: a chart drew its
// first frame at the approved canvas while the notes over it were placed for
// the frame its slot gives it.
//
// A size the observer reports later is committed at once (flushSync), before
// the frame it reports is painted, as the first is. Left to React's own
// schedule it was drawn a frame late at best, and on a loaded WebKit up to
// half a second late: timers in an aux cell whose field had grown to a
// grid's height stayed listed for 520 ms (#333).
export function useElementSize<T extends Element>(ref: RefObject<T | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element instanceof HTMLElement) {
        setSize({ width: element.offsetWidth, height: element.offsetHeight });
        return;
      }
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    // The first measure is the layout effect's own; the observer's are
    // committed at once, before the frame they report is painted.
    measure();
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
