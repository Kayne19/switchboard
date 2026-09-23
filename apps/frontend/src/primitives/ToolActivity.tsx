import { AnimatePresence, motion } from 'motion/react';
import type { ActivityState } from '../controller/types';
import { ACTIVITY_LINGER_MS, ACTIVITY_MINIMUM_MS, useLingeringValue } from '../hooks/useLingeringValue';

/**
 * The last tool the project agent used: a compact status panel, separate
 * from both the live chat output and the durable notes. It updates when a
 * tool starts and finishes, truncates long names and details, and clears
 * itself when there is no recent activity.
 */
export function ToolActivity({ activity, placement = 'rail' }: { activity: ActivityState | null; placement?: 'rail' | 'conversation' }) {
  const shown = useLingeringValue(activity, ACTIVITY_LINGER_MS, ACTIVITY_MINIMUM_MS);
  const running = shown === activity;
  return (
    <AnimatePresence initial={false}>
      {shown ? (
        <motion.div
          key="tool-activity"
          className={`tool-activity tool-activity--${placement}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          data-testid="tool-activity"
        >
          <div className="tool-activity__header">
            <span className="tool-activity__tag tech micro">
              {running ? 'CURRENT ACTIVITY' : 'LAST TOOL USED'}
            </span>
            <span
              className={`tool-activity__status tech micro tool-activity__status--${running ? 'running' : 'done'}`}
            >
              {running ? '\u25cf RUNNING' : '\u25a0 DONE'}
            </span>
          </div>
          <div className="tool-activity__tool tech" title={shown.tool}>
            {shown.tool || 'TOOL'}
          </div>
          {shown.detail ? (
            <div className="tool-activity__detail tech micro muted" title={shown.detail}>
              {shown.detail}
            </div>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
