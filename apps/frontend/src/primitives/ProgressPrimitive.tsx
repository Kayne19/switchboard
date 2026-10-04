import { motion } from 'motion/react';
import type { ProgressData, ProgressStep, ProgressStepState } from '../controller/types';

/** How many steps a compact slot (the rail, an aux cell) lists before it
 * summarises the rest. The full list is a focus away. */
export const COMPACT_STEPS = 4;

/**
 * The steps a compact slot shows: a window of COMPACT_STEPS placed so the
 * first step still to do is in it with one done step before it for context.
 * Everything before the window is done (that is how it was placed), so it
 * summarises as "N DONE"; everything after it as "N MORE".
 */
export function compactStepWindow(steps: ProgressStep[]): { start: number; end: number } {
  if (steps.length <= COMPACT_STEPS) return { start: 0, end: steps.length };
  const firstOpen = steps.findIndex((step) => step.state !== 'done');
  const anchor = firstOpen < 0 ? steps.length : firstOpen;
  const start = Math.max(0, Math.min(anchor - 1, steps.length - COMPACT_STEPS));
  return { start, end: start + COMPACT_STEPS };
}

function StepGlyph({ state }: { state: ProgressStepState }) {
  // One sharp square per step; its fill and mark say the state, its colour
  // comes from the step's class. The names are the semantic ones so a reader
  // of the DOM, or of a screen reader, gets the same word the agent sent.
  return (
    <svg className="progress-step__glyph" viewBox="0 0 12 12" role="img" aria-label={state}>
      {state === 'todo' ? (
        <rect x="0.75" y="0.75" width="10.5" height="10.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      ) : (
        <rect x="0" y="0" width="12" height="12" fill="currentColor" />
      )}
      {state === 'done' ? <path d="M2.8 6.3 L5.1 8.6 L9.3 3.6" fill="none" stroke="#000" strokeWidth="1.7" /> : null}
      {state === 'blocked' ? <path d="M3.4 3.4 L8.6 8.6 M8.6 3.4 L3.4 8.6" fill="none" stroke="#000" strokeWidth="1.5" /> : null}
    </svg>
  );
}

function StepList({ steps, compact }: { steps: ProgressStep[]; compact: boolean }) {
  const { start, end } = compact ? compactStepWindow(steps) : { start: 0, end: steps.length };
  const after = steps.length - end;
  return (
    <ol className="progress-primitive__steps tech" data-testid="progress-steps" aria-label="Steps">
      {start > 0 ? <li className="progress-step progress-step--elided">{start} DONE</li> : null}
      {steps.slice(start, end).map((step, offset) => {
        const state: ProgressStepState = step.state ?? 'todo';
        return (
          <li className={`progress-step progress-step--${state}`} data-state={state} key={start + offset}>
            <StepGlyph state={state} />
            <span className="progress-step__label">{step.label}</span>
            {step.detail ? <span className="progress-step__detail micro muted">{step.detail}</span> : null}
          </li>
        );
      })}
      {after > 0 ? <li className="progress-step progress-step--elided">{after} MORE</li> : null}
    </ol>
  );
}

/**
 * A bar, and under it the plan the bar measures when the agent sent one. A
 * compact slot lists a window of the steps and counts the rest; the main
 * slot and focus list them all, scrolling inside the frame only when the
 * list outgrows it.
 */
export function ProgressPrimitive({ data, compact = false }: { data: ProgressData; compact?: boolean }) {
  const percentage = Math.min(100, Math.max(0, data.value));
  const steps = data.steps && data.steps.length > 0 ? data.steps : null;
  return (
    <div className={`progress-primitive${steps ? ' progress-primitive--stepped' : ''}`} data-testid="progress">
      <div className="progress-primitive__label">
        <strong>{data.label}</strong>
        <span className="tech micro muted">{data.detail}</span>
      </div>
      <div
        className="progress-primitive__track"
        role="progressbar"
        aria-label={data.text ?? `${Math.round(percentage)} percent`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <motion.div
          className="progress-primitive__fill"
          initial={{ width: '0%' }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.54, ease: [0.22, 0.61, 0.36, 1] }}
        />
      </div>
      <div className="progress-primitive__text tech micro">{data.text ?? `${Math.round(percentage)}% COMPLETE`}</div>
      {steps ? <StepList steps={steps} compact={compact} /> : null}
    </div>
  );
}
