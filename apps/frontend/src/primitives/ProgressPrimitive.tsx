import { motion } from 'motion/react';
import { useRef } from 'react';
import type { ProgressData, ProgressStep, ProgressStepState } from '../controller/types';
import { useScrollDemand } from '../hooks/useStageDemand';

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

/**
 * The steps the rail shows: from the first step still to do, as many as a
 * compact window holds. The rail is the plan's status beside the metrics,
 * so what is done is counted ("N DONE") and what is left is listed; a plan
 * all done lists nothing but its count.
 */
export function aheadStepWindow(steps: ProgressStep[]): { start: number; end: number } {
  const firstOpen = steps.findIndex((step) => step.state !== 'done');
  const start = firstOpen < 0 ? steps.length : firstOpen;
  return { start, end: Math.min(steps.length, start + COMPACT_STEPS) };
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

function StepList({ steps, window }: { steps: ProgressStep[]; window: 'all' | 'around' | 'ahead' }) {
  const { start, end } = window === 'around' ? compactStepWindow(steps) : window === 'ahead' ? aheadStepWindow(steps) : { start: 0, end: steps.length };
  const after = steps.length - end;
  // A plan that outgrows the primary slot says so (useStageDemand).
  const listRef = useRef<HTMLOListElement>(null);
  useScrollDemand(listRef);
  return (
    <ol ref={listRef} className="progress-primitive__steps tech" data-testid="progress-steps" aria-label="Steps">
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
 * Where a progress is drawn decides how much of it shows:
 * - `full`: the main slot and focus, every step listed, scrolling inside the
 *   frame only when the list outgrows it;
 * - `compact`: a cell in the aux row, a window of the steps and a count of
 *   the rest;
 * - `rail`: the module beside the metrics, read the way they are read: a
 *   row with the label and the share done, the bar under it, the steps
 *   done counted on one row and a row per step still to do, up to the
 *   compact window's size.
 */
export type ProgressVariant = 'full' | 'compact' | 'rail';

function ProgressTrack({ data, percentage }: { data: ProgressData; percentage: number }) {
  return (
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
  );
}

/**
 * A bar, and under it the plan the bar measures when the agent sent one.
 * The full plan is always a focus away.
 */
export function ProgressPrimitive({ data, variant = 'full' }: { data: ProgressData; variant?: ProgressVariant }) {
  const percentage = Math.min(100, Math.max(0, data.value));
  const steps = data.steps && data.steps.length > 0 ? data.steps : null;
  const className = `progress-primitive${steps ? ' progress-primitive--stepped' : ''}`;
  if (variant === 'rail') {
    // The head is a metric row, so the module shares the metrics' rhythm,
    // faces and rules by construction rather than by imitation.
    return (
      <div className={`${className} progress-primitive--rail`} data-testid="progress">
        <div className="metric-row progress-primitive__head">
          <span className="metric-row__label tech micro">{data.label}</span>
          <span className="metric-row__value">
            <span className="metric-row__number">{`${Math.round(percentage)}%`}</span>
          </span>
        </div>
        <ProgressTrack data={data} percentage={percentage} />
        {steps ? <StepList steps={steps} window="ahead" /> : null}
      </div>
    );
  }
  return (
    <div className={className} data-testid="progress">
      <div className="progress-primitive__label">
        <strong>{data.label}</strong>
        <span className="tech micro muted">{data.detail}</span>
      </div>
      <ProgressTrack data={data} percentage={percentage} />
      <div className="progress-primitive__text tech micro">{data.text ?? `${Math.round(percentage)}% COMPLETE`}</div>
      {steps ? <StepList steps={steps} window={variant === 'compact' ? 'around' : 'all'} /> : null}
    </div>
  );
}
