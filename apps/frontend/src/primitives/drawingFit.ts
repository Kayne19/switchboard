// How a drawing (a graph or a sequence diagram) meets its frame. Pure, so
// the rule can be checked without a browser.
//
// The rule, one for both drawings (docs/visual-channel.md, "Diagrams that
// outgrow the frame"): a drawing is scaled to fit its viewport, but never
// so far that its text drops below the page's smallest type
// (TYPE_FLOOR_PX). Past that point it is drawn at that readable minimum and
// scrolls inside its viewport, along the axis it overflows; focus gives it
// the whole stage. A layout told the viewport it will be read in
// recomposes for it, so that what scrolls is one axis.

import { TYPE_FLOOR_PX } from '../design/tokens';
import type { Size } from './geometry';

/** A line of text a drawing sets, in user units, and the page face whose floor it must keep. */
export interface DrawingText {
  size: number;
  floor: keyof typeof TYPE_FLOOR_PX;
}

/** The least scale at which every line of a drawing's text meets the page's type floors. */
export function readableScale(texts: DrawingText[]): number {
  return Math.max(0, ...texts.map((text) => TYPE_FLOOR_PX[text.floor] / text.size));
}

export interface Viewport extends Size {
  /** How much room a scroll bar takes across the axis that scrolls: the drawing is sized to what is left there, so one bar never brings on the other. */
  scrollbar: number;
}
// A drawing that scrolls fills its viewport across, but no larger than its
// own size: past that it would only scroll longer.
const MAX_SCROLLING_SCALE = 1;
// A drawing that would overflow by a sliver at the readable minimum is
// contained instead, its text at most this much under the floor (0.3px on
// a 7px line): scrolling a few pixels for the last of a drawing costs the
// reader more than that.
export const SLIVER = 0.04;

export interface DrawingFit {
  /** CSS pixels per user unit. */
  scale: number;
  /** The drawing's size on screen, in CSS pixels. */
  width: number;
  height: number;
  /** Whether the viewport scrolls along each axis. */
  scrollX: boolean;
  scrollY: boolean;
  /** The least scale the drawing reads at, the one it was fitted with: what it asks of a slot to be read whole (useStageDemand). */
  minScale: number;
}

/**
 * The scale a drawing is shown at in a viewport. One that fits at
 * `minScale` or more (less a sliver) is contained, as large as fits. One that does not
 * scrolls along the axis it overflows most, filling the other axis (up to
 * its own size) and never drawn smaller than `minScale`; it scrolls along
 * the other axis too only when even `minScale` overflows that.
 */
export function fitDrawing(drawing: Size, viewport: Viewport, minScale: number): DrawingFit {
  const fitWidth = viewport.width / drawing.width;
  const fitHeight = viewport.height / drawing.height;
  const contain = Math.min(fitWidth, fitHeight);
  if (contain >= minScale * (1 - SLIVER)) {
    return { scale: contain, width: drawing.width * contain, height: drawing.height * contain, scrollX: false, scrollY: false, minScale };
  }
  const scrollsDown = fitHeight <= fitWidth;
  const room = {
    width: viewport.width - (scrollsDown ? viewport.scrollbar : 0),
    height: viewport.height - (scrollsDown ? 0 : viewport.scrollbar),
  };
  const fill = scrollsDown ? room.width / drawing.width : room.height / drawing.height;
  const scale = Math.max(minScale, Math.min(fill, MAX_SCROLLING_SCALE));
  const width = drawing.width * scale;
  const height = drawing.height * scale;
  return { scale, width, height, scrollX: !scrollsDown || width > room.width + 0.5, scrollY: scrollsDown || height > room.height + 0.5, minScale };
}

/** How many viewports of reading a fit asks for: 1 when it fits, more the further it scrolls, most when it scrolls both ways. */
export function scrollCost(fit: DrawingFit, viewport: Size): number {
  return Math.max(1, fit.width / viewport.width) * Math.max(1, fit.height / viewport.height);
}
