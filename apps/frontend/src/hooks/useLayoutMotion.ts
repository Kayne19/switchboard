import { useReducedMotionConfig, type MotionProps } from 'motion/react';

/** What an element hands motion's layout projection: its own moves and resizes (`layout`), and the identity it shares with another element (`layoutId`: an object and its focus, Damocles from scene to scene). */
export type LayoutMotion = Pick<MotionProps, 'layout' | 'layoutId'>;

/**
 * The layout props a motion element takes: `motion` as asked, and none
 * under reduced motion, where a layout change is drawn where it ends.
 *
 * Under reduced motion motion still runs a layout animation, as an instant
 * one: it draws the element at its old box (the animation's first frame) in
 * the flush after the commit, and at its new box in the next frame. A
 * render is asked once per timestamp, and the flush stamps the frame with
 * the time of the commit, so a next frame that comes within the same tick
 * of the clock (a commit that ends as a frame is due) asks again and is
 * not drawn: the element keeps its old box for good, scaled to it (the
 * main column at scaleY(0.9825) on a phone, its rail and Damocles with it).
 * With no layout props there is no projection to leave behind, and nothing
 * moved either way. Motion reads the setting once, when an element mounts,
 * and so does this.
 */
export function useLayoutMotion(motion: LayoutMotion): LayoutMotion {
  return useReducedMotionConfig() ? {} : motion;
}
