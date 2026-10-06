import { useLayoutEffect, useState } from 'react';

// The page's one clock (docs/visual-channel.md, "The page clock"). Only a
// timer reads the time: a calendar, a to-do list, a forecast and an inbox
// are drawn from the times the agent sent. Every timer on the page reads
// this one clock, so the page runs one timeout however many timers it
// shows, and none while no countdown is running.
//
// It ticks where a countdown's reading changes: a whole number of seconds
// before or after its end, so at the fraction of a second its end falls
// on (its phase, timerReading `timerPhase`). Each reader says the phases
// of the countdowns it shows, and the one timeout is set for the soonest
// of them. An agent's end is written to the microsecond (the skill adds
// minutes to its clock's now), so a clock on the whole second showed a
// digit too many for up to a second and reached the end late. Two
// countdowns that end on the same fraction turn over on the same tick.

type Listener = (now: number) => void;

const SECOND = 1000;

// Each reader, and the phases (milliseconds past the whole second, 0 to
// 999) its countdowns turn over on.
const listeners = new Map<Listener, readonly number[]>();
let current = 0;
let pending: ReturnType<typeof setTimeout> | null = null;

/** Milliseconds from `now` to the next moment after it on one of the readers' phases: 1 to 1000. */
function untilNextTurn(now: number): number {
  let soonest = SECOND;
  for (const phases of listeners.values()) {
    for (const phase of phases) {
      const wait = (((phase - now) % SECOND) + SECOND) % SECOND;
      // A wait of none is this moment, read already; that phase is next a second on.
      if (wait > 0 && wait < soonest) soonest = wait;
    }
  }
  return soonest;
}

// The one timeout, set again for the readers there are now.
function schedule(): void {
  if (pending !== null) clearTimeout(pending);
  pending = listeners.size > 0 ? setTimeout(tick, untilNextTurn(Date.now())) : null;
}

function tick(): void {
  pending = null;
  current = Date.now();
  for (const listener of Array.from(listeners.keys())) listener(current);
  schedule();
}

// A reader that joins reads the time now, not the last tick: that tick was
// on the others' phases, and one of its own may have passed since.
function subscribe(listener: Listener, phases: readonly number[]): () => void {
  current = Date.now();
  listeners.set(listener, phases);
  schedule();
  return () => {
    listeners.delete(listener);
    schedule();
  };
}

/** The page clock's time, in epoch milliseconds: the last tick while it runs. */
function pageNow(): number {
  return listeners.size > 0 ? current : Date.now();
}

/**
 * The page clock, read by a component: the time now, updated at each turn
 * of the countdowns it shows while any of them is moving (`phases`, each
 * running countdown's `timerPhase`), and read once while none is (a paused
 * timer does not move).
 */
export function usePageClock(phases: readonly number[]): number {
  const [now, setNow] = useState(pageNow);
  // The phases by value: a render that keeps them keeps the subscription.
  const key = [...new Set(phases)].sort((a, b) => a - b).join(' ');
  // Before paint: a timer that starts running (a paused one resumed) is
  // drawn at the time now on its first frame, not at the time it mounted,
  // and its bar never sweeps from a stale share.
  useLayoutEffect(() => {
    if (key === '') return undefined;
    const unsubscribe = subscribe(setNow, key.split(' ').map(Number));
    setNow(pageNow());
    return unsubscribe;
  }, [key]);
  return now;
}
