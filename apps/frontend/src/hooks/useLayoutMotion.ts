import { useReducedMotionConfig, type MotionProps } from 'motion/react';
import { createContext, useContext } from 'react';

/** What an element hands motion's layout projection: its own moves and resizes (`layout`), and the identity it shares with another element (`layoutId`: an object and its focus, Damocles from scene to scene). */
export type LayoutMotion = Pick<MotionProps, 'layout' | 'layoutId'>;

/**
 * The layout props a motion element takes: `motion` as asked, and none
 * under reduced motion, where a layout change is drawn where it ends.
 *
 * Under reduced motion motion still runs a layout animation, as an instant
 * one: it draws the element at its old box (the animation's first frame) in
 * the flush after the commit, and at its new box in the next frame. A
 * render is asked once per timestamp (motion-dom 12.43 and 14.0,
 * `VisualElement.scheduleRender`), and the flush stamps the frame with the
 * time of the commit, so a next frame that comes within the same tick of
 * the clock (a commit that ends as a frame is due) asks again and is not
 * drawn: the element keeps its old box for good, scaled to it (the main
 * column at scaleY(0.9825) on a phone, its rail and Damocles with it). The
 * tick is what makes it likely: Firefox and Safari read the clock in whole
 * milliseconds, as Playwright's pinned clock does (one load in four of a
 * phone source with timers beside it); Chrome's 0.1 ms tick made it rare.
 * With no layout props there is no projection to leave behind, and nothing
 * moved either way. Motion reads the setting once, when an element mounts,
 * and so does this (a list's rows take the list's).
 */
export function useLayoutMotion(motion: LayoutMotion): LayoutMotion {
  return useReducedMotionConfig() ? {} : motion;
}

/** The id of the object the focus layer holds, or null: the stage provides it (SceneRenderer). */
export const FocusedObject = createContext<string | null>(null);

/**
 * Whether an object's slot copy stands aside for its focus. Where motion is
 * not reduced the slot copy and the focus share one identity
 * (`switchboard-object-<id>`), and motion hides the copy that does not lead,
 * so the focus grows out of the slot and the slot stands empty under it.
 * Under reduced motion there is no shared identity (above), and the copy
 * stayed in its slot under the backdrop, the focus fading in over it. Here
 * it is hidden instead, as motion would have hidden it: no box moves.
 */
export function useFocusCopyHidden(objectId: string): boolean {
  const reduced = useReducedMotionConfig();
  const focused = useContext(FocusedObject);
  return Boolean(reduced) && focused === objectId;
}
