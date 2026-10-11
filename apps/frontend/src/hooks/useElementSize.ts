import { type RefObject } from 'react';
import type { Size } from '../primitives/geometry';
import { useMeasured } from './useMeasured';

const NO_SIZE: Size = { width: 0, height: 0 };
const sameSize = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

// An HTML element is read through its offset size, which a transform does
// not change: a shared-layout animation scales the box it moves, and a size
// read mid-flight would lay a drawing out for a frame it never settles in.
function layoutSize(element: Element): Size {
  if (element instanceof HTMLElement) return { width: element.offsetWidth, height: element.offsetHeight };
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

// The element's layout size (useMeasured): read in a layout effect, so the
// first frame painted is drawn at the size read, not at none -- a chart drew
// its first frame at the approved canvas while the notes over it were placed
// for the frame its slot gives it -- and committed in the frame each later
// size is reported in: timers in an aux cell whose field had grown to a
// grid's height stayed listed for 520 ms on a loaded WebKit (#333).
export function useElementSize<T extends Element>(ref: RefObject<T | null>): Size {
  return useMeasured(() => ref.current, layoutSize, { initial: NO_SIZE, same: sameSize }, [ref]);
}
