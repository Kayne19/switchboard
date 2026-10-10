import { useLayoutEffect, useState, type RefObject } from 'react';

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
 * `target` is the control focus belongs on; it may name another control
 * while the dialog is open (the history's field as the line comes up).
 *
 * The holder is read in a layout effect, in the commit that opens the
 * dialog: that commit makes it inert (or hides it), and the browser then
 * moves focus to the body before a passive effect would run for an
 * update the agent sent. It is the same commit as the tap that opened it,
 * which is when a touch keyboard may come up for a field focused here.
 *
 * The lifecycle is one machine (`ModalFocus`, below): one state, one
 * writer, its phase x event table pinned by `modalFocus.test.tsx`.
 */
export function useModalFocus(open: boolean, layer: string, target: RefObject<HTMLElement | null>): void {
  const [focus] = useState(() => new ModalFocus(layer));
  // Keyed on the dialog opening and closing only: a new target while it
  // is open is not a new dialog to take focus into and give it back from.
  useLayoutEffect(() => {
    if (!open) return;
    focus.open(target.current);
    return () => focus.close();
  }, [open]);
  // A target ref of its own for each control: a new ref is a new target,
  // in the commit that makes it one. While closed it changes nothing.
  useLayoutEffect(() => {
    focus.retarget(target.current);
  }, [target]);
}

/**
 * How many times focus is offered back to the opener: once after the
 * closing commit, then once a frame, a second in all.
 */
const GIVE_BACK_TRIES = 60;

/**
 * A give-back try that is due: the closing commit's microtask (`frame`
 * null), or an animation frame. Each try is a new object, so one that
 * outlives the phase that scheduled it is known and dropped.
 */
interface Due {
  frame: number | null;
}

/** Where a dialog's focus is in its life. Each phase holds what exists only in it. */
type ModalFocusPhase =
  | { kind: 'closed' }
  /** `opener` held focus before the dialog opened (null: nothing did); `target` is where focus belongs in it. */
  | { kind: 'open'; opener: HTMLElement | null; target: HTMLElement | null }
  /** Closed and giving focus back to `opener`: `due` is the next try, `triesLeft` more may follow it. */
  | { kind: 'restoring'; opener: HTMLElement; due: Due; triesLeft: number };

/** What moves a dialog's focus. A try names itself, so one its phase let go of is dropped. */
type ModalFocusEvent =
  | { kind: 'open'; target: HTMLElement | null }
  | { kind: 'retarget'; target: HTMLElement | null }
  | { kind: 'close' }
  | { kind: 'due'; due: Due };

const CLOSED: ModalFocusPhase = { kind: 'closed' };

function dueOf(phase: ModalFocusPhase): Due | null {
  switch (phase.kind) {
    case 'restoring':
      return phase.due;
    case 'closed':
    case 'open':
      return null;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

/** Whether `event` comes from the phase the dialog is in, rather than from a try it has let go of. */
function fromCurrentPhase(phase: ModalFocusPhase, event: ModalFocusEvent): boolean {
  switch (event.kind) {
    case 'open':
    case 'retarget':
    case 'close':
      return true;
    case 'due':
      return dueOf(phase) === event.due;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * The one teardown: a try `from` scheduled and `to` does not hold is
 * cancelled. Opening the dialog again while focus is still being given
 * back ends the tries; before, they ran on, harmless only because the
 * opener was inert behind the dialog.
 */
function leave(from: ModalFocusPhase, to: ModalFocusPhase): void {
  const due = dueOf(from);
  if (due !== null && due !== dueOf(to) && due.frame !== null) cancelAnimationFrame(due.frame);
}

/** Whether `element` can still hold focus: on the page and not disabled. */
function canHoldFocus(element: HTMLElement): boolean {
  return element.isConnected && !element.matches(':disabled');
}

/** One dialog's focus, from opening to the last try to give it back. */
class ModalFocus {
  private phase: ModalFocusPhase = CLOSED;

  constructor(private readonly layer: string) {}

  open(target: HTMLElement | null): void {
    this.transition({ kind: 'open', target });
  }

  retarget(target: HTMLElement | null): void {
    this.transition({ kind: 'retarget', target });
  }

  close(): void {
    this.transition({ kind: 'close' });
  }

  /** The only writer of `phase`. */
  private transition(event: ModalFocusEvent): void {
    const from = this.phase;
    if (!fromCurrentPhase(from, event)) return;
    const to = this.next(from, event);
    if (to === from) return;
    this.phase = to;
    leave(from, to);
  }

  /**
   * The phase x event table (pinned by `modalFocus.test.tsx`): the phase
   * `event` moves the dialog's focus to, entered with the focus it moves,
   * or `phase` itself when the event changes nothing.
   */
  private next(phase: ModalFocusPhase, event: ModalFocusEvent): ModalFocusPhase {
    switch (event.kind) {
      case 'open':
        return phase.kind === 'open' ? phase : this.enter(event.target);
      case 'retarget':
        if (phase.kind !== 'open' || event.target === phase.target) return phase;
        // A control the caller can use took the place of one that is
        // still there (the history's field as the line comes up): focus
        // moves to it, in the commit that makes it one.
        if (phase.target === null || canHoldFocus(phase.target)) {
          event.target?.focus({ preventScroll: true });
        }
        return { kind: 'open', opener: phase.opener, target: event.target };
      case 'close':
        if (phase.kind !== 'open') return phase;
        // After the commit: React puts back the focus it saw before a
        // commit's DOM changes once they are made, and a layout effect's
        // cleanup runs among them, so a focus given here would be undone.
        return phase.opener
          ? { kind: 'restoring', opener: phase.opener, due: this.schedule(false), triesLeft: GIVE_BACK_TRIES - 1 }
          : CLOSED;
      case 'due':
        return phase.kind === 'restoring' ? this.giveBack(phase) : phase;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  /** Enter `open`: read what holds focus, and move focus to `target`. */
  private enter(target: HTMLElement | null): ModalFocusPhase {
    const held = document.activeElement;
    const opener = held instanceof HTMLElement && held !== document.body ? held : null;
    // The control draws the page's ring only when the keyboard opened the
    // dialog: focus the agent opened, or a tap, leaves the ring off until a
    // key. A text field always matches :focus-visible, so it says nothing of
    // a key.
    const keyed = Boolean(opener?.matches(':focus-visible') && !opener.matches('input, textarea'));
    target?.focus({ preventScroll: true, focusVisible: keyed } as FocusOptions);
    return { kind: 'open', opener, target };
  }

  /**
   * One try to give focus back. Where motion's shared identity hides the
   * slot copy, it shows again when the layout animation lets it go, a
   * frame or the rest of the animation later: the opener is tried each
   * frame until it takes focus, while focus has gone nowhere else, for at
   * most `GIVE_BACK_TRIES`.
   */
  private giveBack({ opener, triesLeft }: Extract<ModalFocusPhase, { kind: 'restoring' }>): ModalFocusPhase {
    // An inert opener cannot take focus: one in a scene that is leaving
    // (Scenes.tsx makes it inert until its exit ends), or behind a dialog
    // still open.
    if (!opener.isConnected || opener.closest('[inert]') !== null) return CLOSED;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest(this.layer)) return CLOSED;
    opener.focus({ preventScroll: true });
    if (document.activeElement === opener || triesLeft === 0) return CLOSED;
    return { kind: 'restoring', opener, due: this.schedule(true), triesLeft: triesLeft - 1 };
  }

  /** Schedule a try: in a microtask after the closing commit, or in the next frame. */
  private schedule(nextFrame: boolean): Due {
    const due: Due = { frame: null };
    const fire = () => this.transition({ kind: 'due', due });
    if (nextFrame) due.frame = requestAnimationFrame(fire);
    else queueMicrotask(fire);
    return due;
  }
}
