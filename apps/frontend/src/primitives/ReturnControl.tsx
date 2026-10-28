import type { RefObject } from 'react';

/**
 * The exit button of a dialog or view. Runs `onClose` on click; `buttonRef`,
 * when given, receives the button so the caller can move focus to it.
 */
export function ReturnControl({
  label,
  onClose,
  buttonRef,
}: {
  label: string;
  onClose: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button ref={buttonRef} className="return-control" type="button" onClick={onClose}>
      {label}
    </button>
  );
}
