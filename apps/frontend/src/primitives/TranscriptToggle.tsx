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
