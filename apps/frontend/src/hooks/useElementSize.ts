import { useEffect, useState, type RefObject } from 'react';
import type { Size } from '../primitives/geometry';

// The element's layout size. An HTML element is read through its offset
// size, which a transform does not change: a shared-layout animation scales
// the box it moves, and a size read mid-flight would lay a drawing out for
// a frame it never settles in.
export function useElementSize<T extends Element>(ref: RefObject<T | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
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
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
