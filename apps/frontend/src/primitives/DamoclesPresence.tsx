import { AnimatePresence, motion } from 'motion/react';
import type { ActivityState } from '../controller/types';
import { useFloatingMotion } from '../hooks/useFloatingMotion';
import { ACTIVITY_LINGER_MS, useLingeringValue } from '../hooks/useLingeringValue';
import { DamoclesGlyph } from './DamoclesGlyph';
import { VoiceIndicator } from './VoiceIndicator';

export type PresenceSize = 'idle' | 'conversation' | 'rail' | 'compact';

export function DamoclesPresence({
  listening,
  onToggleListening,
  context = 'GENERAL',
  size = 'rail',
  showCaption = true,
  interactive = true,
  layoutId = 'damocles-presence',
  activity = null,
}: {
  listening: boolean;
  onToggleListening?: () => void;
  context?: string;
  size?: PresenceSize;
  showCaption?: boolean;
  interactive?: boolean;
  layoutId?: string;
  /** The tool the agent is running; the caption names it in place of the voice line. */
  activity?: ActivityState | null;
}) {
  const shownActivity = useLingeringValue(activity, ACTIVITY_LINGER_MS);
  const { y, rotate } = useFloatingMotion({ listening, amplitude: size === 'idle' ? 8.5 : size === 'conversation' ? 5.5 : 4 });
  const content = (
    <>
      <motion.div className="damocles-presence__float" style={{ y, rotate }}>
        <DamoclesGlyph glint={listening} title="Damocles" />
      </motion.div>
      <div className="damocles-presence__signal">
        <AnimatePresence mode="wait" initial={false}>
          {listening ? (
            <VoiceIndicator key="voice" compact={size === 'compact' || size === 'rail'} />
          ) : showCaption ? (
            <motion.div key="caption" className="damocles-presence__caption tech micro" title={shownActivity?.detail || undefined} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
              {shownActivity ? `WORKING / ${shownActivity.tool || 'TOOL'}` : 'VOICE / ACTIVE'}<br/><span className="muted">CONTEXT / {context}</span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
  return (
    <motion.div className={`damocles-presence damocles-presence--${size}`} layoutId={layoutId} layout="position" transition={{ layout: { duration: 0.42, ease: [0.22,0.61,0.36,1] } }} data-testid="damocles-presence">
      {interactive ? (
        <button className="damocles-presence__button" type="button" onClick={onToggleListening} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Start listening'}>{content}</button>
      ) : (
        <div className="damocles-presence__button damocles-presence__button--static">{content}</div>
      )}
    </motion.div>
  );
}
