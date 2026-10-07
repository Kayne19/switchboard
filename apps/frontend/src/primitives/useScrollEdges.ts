import { useLayoutEffect, useState, type RefObject } from 'react';
import { watchElement } from '../hooks/watchElement';
import { continuesPast, fadeDepth } from './ListViewport';

/** Where a scroller continues past its top or its foot, and how deep a fade there reaches (ScrollRim). */
interface ScrollEdges {
  above: boolean;
  below: boolean;
  fade: number;
}

const NONE: ScrollEdges = { above: false, below: false, fade: 0 };
const same = (a: ScrollEdges, b: ScrollEdges) => a.above === b.above && a.below === b.below && a.fade === b.fade;

/**
 * The edges a scroller continues past (`continuesPast`, the one rule every
 * scroller reads its edges by), read again as it is resized, its content
 * changes, or it scrolls (once a frame), so each can fade as every
 * scroller's edge does (ScrollRim). Off (`watching` false), none.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, watching = true): ScrollEdges {
  const [edges, setEdges] = useState(NONE);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!watching || !element) {
      setEdges(NONE);
      return undefined;
    }
    const measure = () => {
      const goes = continuesPast(element.scrollTop, element.clientHeight, element.scrollHeight);
      const next: ScrollEdges = { above: goes.top, below: goes.bottom, fade: fadeDepth(element.clientHeight) };
      setEdges((current) => (same(current, next) ? current : next));
    };
    // Where there is no ResizeObserver (a test's DOM), it is read once and on scroll.
    const stop = typeof ResizeObserver === 'undefined' ? (measure(), () => {}) : watchElement(element, measure, { children: true, changes: true });
    let frame = 0;
    const scrolled = () => {
      if (frame === 0) frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    element.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      stop();
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', scrolled);
    };
  }, [ref, watching]);
  return watching ? edges : NONE;
}
