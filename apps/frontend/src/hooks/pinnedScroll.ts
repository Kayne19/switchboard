/**
 * Where a scrolling log stands with its reader. `following` rests at the pin
 * (the newest section) and moves with new content. `reading` stays where the
 * reader scrolled to. `held` is not read at all (a surface that is not a log,
 * or a log the reader paused) and remembers which of the two it comes back as.
 */
export type PinnedScroll =
  | { readonly kind: 'following' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'held'; readonly resume: 'following' | 'reading' };

export type PinnedScrollEvent =
  | { readonly kind: 'scrolled'; readonly atPin: boolean }
  | { readonly kind: 'contentChanged' }
  | { readonly kind: 'resized' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'release' };

export interface PinnedScrollStep {
  readonly state: PinnedScroll;
  /** `pin`: the element moves to its pin now. */
  readonly effect: 'pin' | 'none';
}

export const FOLLOWING: PinnedScroll = { kind: 'following' };
const READING: PinnedScroll = { kind: 'reading' };

/** The one transition of a pinned log: every pin and every unpin is decided here. */
export function nextScroll(state: PinnedScroll, event: PinnedScrollEvent): PinnedScrollStep {
  if (state.kind === 'held') {
    if (event.kind !== 'release') return { state, effect: 'none' };
    return state.resume === 'following' ? { state: FOLLOWING, effect: 'pin' } : { state: READING, effect: 'none' };
  }
  switch (event.kind) {
    case 'scrolled':
      return { state: event.atPin ? FOLLOWING : READING, effect: 'none' };
    case 'contentChanged':
    case 'resized':
      return { state, effect: state.kind === 'following' ? 'pin' : 'none' };
    case 'hold':
      return { state: { kind: 'held', resume: state.kind }, effect: 'none' };
    case 'release':
      return { state, effect: 'none' };
  }
}
