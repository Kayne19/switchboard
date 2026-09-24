import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ActivityState } from '../controller/types';
import { ACTIVITY_LINGER_MS, ACTIVITY_MINIMUM_MS, useLingeringValue } from '../hooks/useLingeringValue';

/**
 * The last tool the project agent used: a compact status panel, separate
 * from both the live chat output and the durable notes. It updates when a
 * tool starts and finishes, truncates long names and details, and clears
 * itself when there is no recent activity.
 *
 * The panel stays up through a run of calls, but every call registers on
 * it: a sweep runs along its top rule and the tool's name comes in afresh,
 * so ten calls of one tool read as ten calls rather than one still running.
 *
 * In the rail it sits in its own slot at the foot of the column. With
 * `reserveSpace` the slot keeps the panel's full height whether a tool is
 * shown or not, so the surfaces that stretch into the rest of the column
 * never resize when it comes or goes, and the panel never covers them.
 */
export function ToolActivity({
  activity,
  placement = 'rail',
  reserveSpace = false,
}: {
  activity: ActivityState | null;
  placement?: 'rail' | 'conversation';
  reserveSpace?: boolean;
}) {
  const reduced = useReducedMotion();
  const shown = useLingeringValue(activity, ACTIVITY_LINGER_MS, ACTIVITY_MINIMUM_MS);
  const running = shown === activity;
  const panel = (
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
          data-call={shown.call}
        >
          <motion.span
            key={`sweep-${shown.call ?? 0}`}
            className="tool-activity__sweep"
            aria-hidden="true"
            initial={reduced ? false : { scaleX: 0, opacity: 1 }}
            animate={{ scaleX: 1, opacity: 0 }}
            transition={{ scaleX: { duration: 0.26, ease: [0.22, 0.61, 0.36, 1] }, opacity: { duration: 0.42, delay: 0.22 } }}
          />
          <div className="tool-activity__header">
            <span className="tool-activity__tag tech micro">
              {running ? 'CURRENT ACTIVITY' : 'LAST TOOL USED'}
            </span>
            <span
              className={`tool-activity__status tech micro tool-activity__status--${running ? 'running' : 'done'}`}
            >
              {running ? '● RUNNING' : '■ DONE'}
            </span>
          </div>
          <motion.div
            key={`call-${shown.call ?? 0}`}
            className="tool-activity__call"
            initial={reduced ? false : { opacity: 0.2, y: 5, filter: 'blur(3px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <div className="tool-activity__tool tech" title={shown.tool}>
              {shown.tool || 'TOOL'}
            </div>
            {shown.detail ? (
              <div className="tool-activity__detail tech micro muted" title={shown.detail}>
                {shown.detail}
              </div>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
  if (placement !== 'rail') return panel;
  return (
    <div className="tool-activity-slot">
      {reserveSpace ? (
        // The panel's own three lines, unseen, so the reserved height is
        // exactly the panel's at every geometry.
        <div className="tool-activity-slot__sizer" aria-hidden="true">
          <div className="tool-activity__header">
            <span className="tool-activity__tag tech micro">{' '}</span>
          </div>
          <div className="tool-activity__tool tech">{' '}</div>
          <div className="tool-activity__detail tech micro">{' '}</div>
        </div>
      ) : null}
      {panel}
    </div>
  );
}
