import { WAKE_PHRASE } from '../hands_free';

/**
 * The CHANNEL / MODE stack in the bottom-left corner of every page (#180),
 * drawn by the scene shell once.
 *
 * CHANNEL names how the caller is on the line. Only voice exists today; a
 * text channel is a later issue, so the line is shown and does nothing.
 *
 * MODE is the page's one hands-free control. It reads the mode the voice
 * runtime reports and switches it through that runtime (`toggleHandsFree`
 * in `runtime/callRuntime.ts`); this primitive holds no listening state,
 * so the page cannot disagree with the transport about what the microphone
 * is doing. Without a runtime -- the demo page -- there is nothing to
 * switch, and the control is disabled rather than silently inert.
 */
export function ChannelStack({ handsFree, onToggleMode }: { handsFree: boolean; onToggleMode?: () => void }) {
  return (
    <div className="channel-stack tech micro">
      <span className="channel-stack__channel">CHANNEL / VOICE</span>
      <button
        className="channel-stack__mode"
        type="button"
        aria-pressed={handsFree}
        disabled={onToggleMode === undefined}
        onClick={onToggleMode}
      >
        MODE / {modeReading(handsFree)}
      </button>
    </div>
  );
}

/** What MODE reads: the wake word is named while it is what opens a turn. */
export function modeReading(handsFree: boolean): string {
  return handsFree ? `HANDS-FREE \u00b7 ${WAKE_PHRASE.toUpperCase()}` : 'PUSH-TO-TALK';
}
