import { useLayoutEffect, type RefObject } from 'react';

/**
 * A modal dialog over the stage -- the focus layer (FocusLayer) or the
 * history (TranscriptDrawer) -- and focus acts as one: it moves to the
 * control the returned ref is on as the dialog opens, stays in the dialog
 * (everything behind it is `inert` while it is open: the scene, SceneShell
 * `behindModal`; behind the focus layer also the history, TranscriptDrawer,
 * and on the demo page the CTRL button, both panels and the scene keys,
 * App), and goes back to what held it before when the dialog closes: the
 * surface or toggle that was activated, or the field the caller was typing
 * in when the agent opened it. A dialog opened with nothing held gives
 * focus back to nothing. Before, the focus layer only said it was modal:
 * Tab walked on into the stage behind the backdrop; the history did the
 * same until it took this hook too (#268). `layer` is the dialog's
 * selector: focus is given back only while it is in the dialog, or nowhere.
 *
 * The holder is read in a layout effect, in the commit that opens the
 * dialog: that commit makes it inert (or hides it), and the browser then
 * moves focus to the body before a passive effect would run for an
 * update the agent sent. It is the same commit as the tap that opened it,
 * which is when a touch keyboard may come up for a field focused here.
 */
export function useModalFocus(open: boolean, layer: string, first: RefObject<HTMLElement | null>): void {
  // Keyed on the dialog opening and closing only: `first` may name another
  // control while it is open (the history's field once the line is up), and
  // that is not a new dialog to take focus into and give it back from.
  useLayoutEffect(() => {
    if (!open) return;
    const held = document.activeElement;
    const opener = held instanceof HTMLElement && held !== document.body ? held : null;
    // The control draws the page's ring only when the keyboard opened the
    // dialog: focus the agent opened, or a tap, leaves the ring off until a
    // key. A text field always matches :focus-visible, so it says nothing of
    // a key.
    const keyed = Boolean(opener?.matches(':focus-visible') && !opener.matches('input, textarea'));
    first.current?.focus({ preventScroll: true, focusVisible: keyed } as FocusOptions);
    return () => {
      if (!opener) return;
      // Where motion's shared identity hides the slot copy, it shows again
      // when the layout animation lets it go, a frame or the rest of the
      // animation later: try each frame until it takes focus, while focus
      // has gone nowhere else, for at most a second.
      let frames = 0;
      const giveBack = () => {
        if (!opener.isConnected || leaving(opener)) return;
        const active = document.activeElement;
        if (active && active !== document.body && !active.closest(layer)) return;
        opener.focus({ preventScroll: true });
        if (document.activeElement !== opener && (frames += 1) < 60) requestAnimationFrame(giveBack);
      };
      // After the commit: React puts back the focus it saw before a commit's
      // DOM changes once they are made, and a layout effect's cleanup runs
      // among them, so a focus given here would be undone.
      queueMicrotask(giveBack);
    };
  }, [open, layer]);
}

/** Whether `element` is in a scene that is leaving: the stage draws the scene it goes to after it. */
function leaving(element: Element): boolean {
  const scene = element.closest('.stage > [data-scene]');
  return scene !== null && scene !== [...document.querySelectorAll('.stage > [data-scene]')].at(-1);
}
