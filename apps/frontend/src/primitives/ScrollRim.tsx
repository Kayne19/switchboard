import type { CSSProperties, MouseEvent } from 'react';
import type { Side } from './drawingScroll';

/** The chevron a rim's count points with, and the rail handle's. */
export function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 8 6" aria-hidden="true">
      <path d="M 4 0 L 8 6 L 0 6 Z" />
    </svg>
  );
}

/**
 * One edge a scroller continues past, drawn the same way by every scroller
 * (a drawing, a list, a calendar's paged days), so they read as one
 * instrument:
 * - the fade (`fade`, its depth in px), darkest at the rim, so a cut row or
 *   part reads as the next one coming rather than as broken;
 * - the rail, the dashed cut line on the rim;
 * - the count tag (`text`) on the rail, its chevron pointing that way. A
 *   tap on it turns a page that way (`onPage`), and is marked handled
 *   (FocusableSurface's rule), so the surface around does not expand.
 * A side with no fade draws none; a side with no text draws no rail and no
 * tag. `inset` starts the edge below a band pinned at the scroller's top
 * (and the side rails under it); `at` stands the tag along its rail, in px
 * from the rail's start, where it is not centred by the stylesheet.
 */
export function ScrollRim({
  side,
  fade = null,
  text = null,
  onPage,
  inset,
  at,
  className,
  count,
}: {
  /** The edge: a drawing has four, a list two. */
  side: Side;
  fade?: number | null;
  text?: string | null;
  onPage: () => void;
  inset?: number;
  at?: number;
  /** The tag's own class, beside the rim's. */
  className?: string;
  /** What the tag counts, for a test to read. */
  count?: number;
}) {
  const along = side === 'left' || side === 'right';
  const below = inset !== undefined && side !== 'bottom' ? { top: `${inset}px` } : null;
  const tagAt: CSSProperties | undefined =
    at === undefined ? undefined : along ? { top: `${at}px` } : { left: `${at}px`, ...(side === 'top' ? below : null) };
  const page = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onPage();
  };
  return (
    <>
      {fade !== null ? (
        <div className={`drawing-viewport__more drawing-viewport__more--${side}`} style={{ [along ? 'width' : 'height']: `${fade}px`, ...below }} aria-hidden="true" />
      ) : null}
      {text !== null ? (
        <>
          <div className={`drawing-viewport__rail drawing-viewport__rail--${side}`} style={below ?? undefined} aria-hidden="true" />
          <div className={`drawing-viewport__rim drawing-viewport__rim--${side}${className ? ` ${className}` : ''}`} style={tagAt} onClick={page} aria-hidden="true" data-count={count}>
            <span className="drawing-viewport__rim-text">{text}</span>
            <Chevron className="drawing-viewport__chevron" />
          </div>
        </>
      ) : null}
    </>
  );
}
