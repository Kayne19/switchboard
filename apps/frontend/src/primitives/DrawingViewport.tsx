import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useElementSize } from '../hooks/useElementSize';
import type { DrawingFit, Size } from './drawingFit';

// How much room the viewport's scroll bar takes, measured once on a probe
// styled as a scrolling viewport: none where scroll bars overlay content.
let scrollbarThickness: number | null = null;
function measureScrollbar(): number {
  if (scrollbarThickness !== null) return scrollbarThickness;
  const probe = document.createElement('div');
  probe.className = 'drawing-viewport__scroll';
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll;scrollbar-width:thin;';
  document.body.append(probe);
  scrollbarThickness = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return scrollbarThickness;
}

/**
 * The viewport a drawing is read in, in CSS pixels: the host's layout size
 * once measured. Until then the first frame falls back to the screen's, so
 * a tall screen never flashes a wide drawing before the observer reports.
 */
export function useDrawingViewport(): { hostRef: RefObject<HTMLDivElement | null>; width: number; height: number; scrollbar: number } {
  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  const measured = size.width > 0 && size.height > 0;
  const viewport: Size = measured ? size : { width: window.innerWidth, height: window.innerHeight };
  const [scrollbar] = useState(measureScrollbar);
  return { hostRef, width: Math.round(viewport.width), height: Math.round(viewport.height), scrollbar };
}

/** A region of a drawing, in its user units. */
export interface DrawingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Edges = { left: boolean; right: boolean; top: boolean; bottom: boolean };
const NONE: Edges = { left: false, right: false, top: false, bottom: false };

/**
 * A drawing in its viewport (drawingFit.ts): contained when it fits at a
 * readable size; otherwise drawn at the fitted scale and scrolled, only
 * along the axis it overflows, inside the viewport, which clips it. The
 * viewport is the host's box, which the scene keeps inside its frame.
 * A drawing that scrolls opens on `lead` (what its note names, or where it
 * begins), and each edge it continues past fades into the black, so a
 * reader sees there is more without a scroll bar to show it. A `pinned`
 * band (a sequence's actor headers) stays at the viewport's top once the
 * drawing has scrolled under it, so a message far down still names its
 * lifelines.
 */
export function DrawingViewport({
  drawing,
  fit,
  lead,
  pinned,
  ariaLabel,
  children,
}: {
  drawing: Size;
  fit: DrawingFit;
  lead?: DrawingRegion | null;
  /** A band at the drawing's top (its headers, `height` user units deep) that stays in view while the rest scrolls under it. */
  pinned?: { height: number; content: ReactNode } | null;
  ariaLabel: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>(NONE);
  const scrolling = fit.scrollX || fit.scrollY;
  const axis = fit.scrollX && fit.scrollY ? 'both' : fit.scrollX ? 'x' : fit.scrollY ? 'y' : 'none';

  const readEdges = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !scrolling) {
      setEdges(NONE);
      return;
    }
    // The pinned band follows the drawing across, as it does not down.
    const band = pinnedRef.current;
    if (band) band.style.transform = `translateX(${Math.max(0, (element.clientWidth - fit.width) / 2) - element.scrollLeft}px)`;
    const next = {
      left: element.scrollLeft > 1,
      right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      top: element.scrollTop > 1,
      bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    };
    setEdges((current) =>
      current.left === next.left && current.right === next.right && current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  }, [scrolling, fit.width]);

  // A new drawing, or a new fit of it, opens on its lead region, centred
  // where the viewport allows.
  const leadX = lead ? lead.x + lead.width / 2 : null;
  const leadY = lead ? lead.y + lead.height / 2 : null;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (scrolling) {
      element.scrollLeft = leadX === null ? 0 : Math.max(0, leadX * fit.scale - element.clientWidth / 2);
      element.scrollTop = leadY === null ? 0 : Math.max(0, leadY * fit.scale - element.clientHeight / 2);
    }
    readEdges();
  }, [drawing, fit.scale, fit.width, fit.height, scrolling, leadX, leadY, readEdges]);

  return (
    <div className={`drawing-viewport${scrolling ? ' drawing-viewport--scrolling' : ''}`} data-scroll={axis}>
      <div ref={scrollRef} className="drawing-viewport__scroll" tabIndex={scrolling ? 0 : undefined} onScroll={scrolling ? readEdges : undefined}>
        <svg
          viewBox={`0 0 ${drawing.width} ${drawing.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={ariaLabel}
          style={scrolling ? { width: `${fit.width}px`, height: `${fit.height}px` } : undefined}
        >
          {children}
        </svg>
      </div>
      {pinned && fit.scrollY ? (
        <div
          ref={pinnedRef}
          className={`drawing-viewport__pinned${edges.top ? ' drawing-viewport__pinned--shown' : ''}`}
          style={{ width: `${fit.width}px`, height: `${pinned.height * fit.scale}px` }}
          aria-hidden="true"
        >
          <svg viewBox={`0 0 ${drawing.width} ${pinned.height}`} preserveAspectRatio="xMidYMin meet">
            {pinned.content}
          </svg>
        </div>
      ) : null}
      {(Object.keys(edges) as Array<keyof Edges>).map((edge) =>
        edges[edge] ? <div key={edge} className={`drawing-viewport__more drawing-viewport__more--${edge}`} aria-hidden="true" /> : null,
      )}
    </div>
  );
}
