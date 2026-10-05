import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
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
  // An offset size is rounded to the pixel and may be up to half a pixel
  // over the box's own; a drawing sized to it would overflow by that much
  // and bring on a scroll bar. The viewport is taken a pixel short.
  const viewport: Size = measured ? { width: size.width - 1, height: size.height - 1 } : { width: window.innerWidth, height: window.innerHeight };
  const [scrollbar] = useState(measureScrollbar);
  return { hostRef, width: Math.max(1, Math.floor(viewport.width)), height: Math.max(1, Math.floor(viewport.height)), scrollbar };
}

/** A region of a drawing, in its user units. */
export interface DrawingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Edges = { left: boolean; right: boolean; top: boolean; bottom: boolean };
const SCROLL_KEYS = new Set([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
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
  const viewportRef = useRef<HTMLDivElement>(null);
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
    // The fades and the pinned band keep off the scroll bars, and the band
    // follows the drawing across, as it does not down.
    viewportRef.current?.style.setProperty('--bar-y', `${element.offsetWidth - element.clientWidth}px`);
    viewportRef.current?.style.setProperty('--bar-x', `${element.offsetHeight - element.clientHeight}px`);
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

  // The drawing opens on its lead region, centred where the viewport
  // allows, when it is first drawn and whenever what is drawn changes shape
  // (its size, its scale, or the region it leads with). An update that
  // leaves those alone (a node's state, a resize that does not move the
  // scale) keeps the reader where they are.
  const leadX = lead ? lead.x + lead.width / 2 : null;
  const leadY = lead ? lead.y + lead.height / 2 : null;
  const shape = `${drawing.width}x${drawing.height}@${fit.scale}/${axis}/${leadX},${leadY}`;
  const shownShape = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && scrolling && shownShape.current !== shape) {
      element.scrollLeft = leadX === null ? 0 : Math.max(0, leadX * fit.scale - element.clientWidth / 2);
      element.scrollTop = leadY === null ? 0 : Math.max(0, leadY * fit.scale - element.clientHeight / 2);
    }
    shownShape.current = shape;
    // The edges and the band follow every render: a resize or an update
    // can change what lies past each edge without moving the reader.
    readEdges();
  });

  // Keys that scroll a focused viewport scroll it; they do not reach the
  // surface around it, which would take Space as "expand".
  const keepScrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(event.key)) event.stopPropagation();
  };

  return (
    <div ref={viewportRef} className={`drawing-viewport${scrolling ? ' drawing-viewport--scrolling' : ''}`} data-scroll={axis}>
      <div
        ref={scrollRef}
        className="drawing-viewport__scroll"
        tabIndex={scrolling ? 0 : undefined}
        onScroll={scrolling ? readEdges : undefined}
        onKeyDown={scrolling ? keepScrollKeys : undefined}
      >
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
        <div className={`drawing-viewport__pinned${edges.top ? ' drawing-viewport__pinned--shown' : ''}`} style={{ height: `${pinned.height * fit.scale}px` }} aria-hidden="true">
          <div ref={pinnedRef} className="drawing-viewport__pinned-drawing" style={{ width: `${fit.width}px` }}>
            <svg viewBox={`0 0 ${drawing.width} ${pinned.height}`} preserveAspectRatio="xMidYMin meet">
              {pinned.content}
            </svg>
          </div>
        </div>
      ) : null}
      {(Object.keys(edges) as Array<keyof Edges>).map((edge) =>
        edges[edge] ? <div key={edge} className={`drawing-viewport__more drawing-viewport__more--${edge}`} aria-hidden="true" /> : null,
      )}
    </div>
  );
}
