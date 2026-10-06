import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Timer, TimerData } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';
import { MeasuredStageDemand } from '../hooks/useStageDemand';
import { usePageClock } from '../hooks/usePageClock';
import { ListViewport } from './ListViewport';
import { MetaTitle } from './MetaTitle';
import { NoteBadge } from './NoteMarker';
import type { Slot } from './slot';
import { CELL_GAP, formatCountdown, instantClock, readTimer, timerGridLeast, timerLayout, type TimerReading } from './timerReading';

// Countdowns and reminders (docs/display-tool.md, "timer"). Every timer is
// read against the page's one clock (usePageClock), which runs only while a
// countdown is moving. A timer's countdown is its figure, in the mono face
// with tabular digits so it does not shimmer as it counts; under it the bar
// of the share gone when the timer has a start, then when it ends. A paused
// timer is frozen and says so; a timer at zero is done, marked in the
// warning colour, and counts how long ago it ended (the agent speaks; the
// page plays nothing). With reduced motion the bar steps with the digits
// instead of sweeping.
//
// The set is laid out for its box (timerLayout): a grid of cells whose
// digits are as large as the box allows, or, where no grid gives readable
// digits (an aux cell holding several), a list of rows that scrolls inside
// its frame like any list.
//
// A box that takes its height from what the timers ask (an aux cell, whose
// row is as tall as its cells ask) is asked for the least height they read
// whole in: their rows' height, or the least grid of readable cells at its
// width where that is less (timerGridLeast). Neither depends on the height
// the box gave them. The field asked what it drew, and a grid laid out for
// its box draws a little less than its box: cells and rows took turns every
// frame (282.8 -> 356.2 -> 310.1 px beside a source at 820x1180).

const PHASE_TEXT: Record<TimerReading['phase'], string> = { running: 'RUNNING', paused: 'PAUSED', done: 'DONE' };

/** The line under a timer's bar: when it ends or ended, and the share gone. */
export function timerMeta(timer: Timer, reading: TimerReading): string {
  const gone = reading.gone !== null && reading.span !== null ? `${Math.round(reading.gone * 100)}% OF ${formatCountdown(reading.span)}` : null;
  const clock = instantClock(timer.endsAt);
  if (reading.phase === 'done') return [clock ? `ENDED ${clock}` : 'ENDED', `+${formatCountdown(reading.over)}`].join(' / ');
  if (reading.phase === 'paused') return gone ?? 'HELD';
  return [clock ? `ENDS ${clock}` : null, gone].filter(Boolean).join(' / ');
}

function PhaseGlyph({ phase }: { phase: TimerReading['phase'] }) {
  return (
    <svg className="timer__phase-glyph" viewBox="0 0 10 10" aria-hidden="true">
      {phase === 'running' ? <path d="M2 1 L9 5 L2 9 Z" /> : null}
      {phase === 'paused' ? <path d="M2 1 H4.2 V9 H2 Z M5.8 1 H8 V9 H5.8 Z" /> : null}
      {phase === 'done' ? <path d="M0.5 0.5 H9.5 V9.5 H0.5 Z" /> : null}
    </svg>
  );
}

// A row in the measure (`measure`) is the row the list draws, unseen
// (and hidden from assistive technology): it names no item.
function TimerItem({ timer, reading, marked, as, measure = false }: { timer: Timer; reading: TimerReading; marked: boolean; as: 'cell' | 'row'; measure?: boolean }) {
  const digits = formatCountdown(reading.phase === 'done' ? 0 : reading.seconds);
  return (
    <li className={`timer-${as} timer-${as}--${reading.phase}${marked ? ` timer-${as}--marked` : ''}`} data-item={measure ? undefined : timer.id} data-phase={reading.phase}>
      {/* The body carries the rule and its tab, so in a tall cell they stand
          over the countdown rather than at the cell's far top. */}
      <div className="timer__body">
        <div className="timer__head">
          <span className="timer__label">{timer.label}</span>
          {marked ? <NoteBadge /> : null}
          <span className={`timer__phase timer__phase--${reading.phase} tech micro`}>
            <PhaseGlyph phase={reading.phase} />
            {PHASE_TEXT[reading.phase]}
          </span>
        </div>
        <div className="timer__digits" role="timer" aria-label={`${timer.label}: ${digits} ${PHASE_TEXT[reading.phase].toLowerCase()}`}>
          {digits}
        </div>
        {reading.gone !== null ? (
          <div className="timer__track" aria-hidden="true">
            <div className="timer__fill" style={{ width: `${(reading.gone * 100).toFixed(3)}%` }} />
          </div>
        ) : null}
        <div className="timer__meta tech micro">{timerMeta(timer, reading)}</div>
      </div>
    </li>
  );
}

/**
 * In the main slot the scene's frame names the timers; elsewhere (an aux
 * cell, focus) no frame does, and the timers lead with their title
 * (MetaTitle), so it shows once wherever they are drawn.
 */
export function TimerPrimitive({ data, marked, slot = 'primary' }: { data: TimerData; marked?: string; slot?: Slot }) {
  const running = data.timers.some((timer) => timer.state !== 'paused');
  const now = usePageClock(running);
  const readings = data.timers.map((timer) => readTimer(timer, now));
  const hostRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(hostRef);
  const chars = Math.max(...readings.map((reading) => formatCountdown(reading.seconds).length));
  const layout = timerLayout(size.width, size.height, data.timers.length, chars);
  const items = data.timers.map((timer, index) => (
    <TimerItem key={timer.id} timer={timer} reading={readings[index]} marked={timer.id === marked} as={layout.kind === 'grid' ? 'cell' : 'row'} />
  ));
  // What the field asks of a box sized by its content: the rows' height,
  // or the least grid at its width where that is less.
  const measureRef = useRef<HTMLOListElement>(null);
  const rowsHeight = useLaidOutHeight(measureRef);
  const gridLeast = timerGridLeast(size.width, data.timers.length, chars);
  const ask = gridLeast === null ? rowsHeight : Math.min(rowsHeight, gridLeast);
  return (
    <div
      className="timer-primitive"
      data-testid="timer"
      data-layout={layout.kind === 'grid' ? `grid-${layout.columns}x${layout.rows}` : 'list'}
      style={layout.kind === 'grid' ? { ['--timer-digits' as string]: `${layout.digits}px`, ['--timer-columns' as string]: layout.columns, ['--timer-rows' as string]: layout.rows, ['--timer-gap' as string]: `${CELL_GAP}px` } : undefined}
    >
      <MetaTitle title={data.title ?? 'TIMERS'} slot={slot} className="timer__title tech micro" />
      {/* The box the timers are laid out for: the primitive's own, inside any padding its slot gives it. */}
      <div ref={hostRef} className="timer-primitive__field" style={{ ['--timer-ask' as string]: `${ask}px` }}>
        {layout.kind === 'grid' ? (
          <ol className="timer-grid">{items}</ol>
        ) : (
          // Before the field is measured the timers are listed as a stand-in: it says nothing to the stage.
          <MeasuredStageDemand measured={size.width > 0 && size.height > 0}>
            <ListViewport noun={['TIMER', 'TIMERS']} lead={marked} scrollClassName="timer-list" label={data.title ?? 'Timers'}>
              <ol className="timer-list__rows">{items}</ol>
            </ListViewport>
          </MeasuredStageDemand>
        )}
        {/* The rows as the list draws them, unseen, in either layout: their height is the field's ask.
            Unmarked: a note's badge changes no row's height, and a note finds its timer once. */}
        <div className="timer-primitive__measure" aria-hidden="true">
          <ol ref={measureRef} className="timer-list__rows">
            {data.timers.map((timer, index) => (
              <TimerItem key={timer.id} timer={timer} reading={readings[index]} marked={false} as="row" measure />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

// The height an element is laid out at, to the layout's own fraction of a
// pixel (offsetHeight rounds it). A ResizeObserver reads layout sizes, which
// a transform leaves alone: a cell scaled while the aux row settles is
// measured at rest.
function useLaidOutHeight<T extends Element>(ref: RefObject<T | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}
