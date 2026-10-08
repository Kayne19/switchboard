import type { CSSProperties } from 'react';
import type { Side } from './drawingScroll';

/**
 * One edge a scroller continues past, drawn the same way by every scroller
 * (a drawing, a list, a calendar's paged days), so they read as one
 * instrument: the fade (`fade`, its depth in px), darkest at the rim, so a
 * cut row or part reads as the next one coming rather than as broken. A
 * side with no fade draws none. `inset` starts the edge below a band
 * pinned at the scroller's top.
 */
export function ScrollRim({
  side,
  fade = null,
  inset,
}: {
  /** The edge: a drawing has four, a list two. */
  side: Side;
  fade?: number | null;
  inset?: number;
}) {
  const along = side === 'left' || side === 'right';
  const below: CSSProperties | null = inset !== undefined && side !== 'bottom' ? { top: `${inset}px` } : null;
  if (fade === null) return null;
  return (
    <div className={`scroll-rim__fade scroll-rim__fade--${side}`} style={{ [along ? 'width' : 'height']: `${fade}px`, ...below }} aria-hidden="true" />
  );
}
