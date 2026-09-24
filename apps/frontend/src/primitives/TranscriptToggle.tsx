export type TranscriptToggleReveal = 'resting' | 'hover';

interface TranscriptToggleProps {
  /** Opens the transcript drawer. */
  onOpen: () => void;
  /**
   * `resting` shows the toggle at its dim resting color, as the conversation
   * scene does. `hover` keeps it in the same place but out of sight until the
   * pointer enters a band along the bottom of the stage or keyboard focus
   * reaches it; where the device cannot hover it stays at rest instead.
   */
  reveal?: TranscriptToggleReveal;
}

// The stage's way into the conversation history, set low and centred. The
// conversation scene shows it at rest; the idle stage hides it in the bottom
// band so a caller who will not speak can still reach the typed line without
// the empty stage showing any chrome around the glyph. One toggle for both,
// so the two cannot drift apart in place, type, or behaviour.
export function TranscriptToggle({ onOpen, reveal = 'resting' }: TranscriptToggleProps) {
  const toggle = (
    <button
      className="transcript-toggle tech micro"
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
    >
      TRANSCRIPT HIDDEN
    </button>
  );
  return reveal === 'hover' ? <div className="transcript-reveal">{toggle}</div> : toggle;
}
