import { useLayoutEffect, useState } from 'react';

// The page's one clock (docs/visual-channel.md, "The page clock"). Only a
// timer reads the time: a calendar, a to-do list, a forecast and an inbox
// are drawn from the times the agent sent. Every timer on the page reads
// this one clock, so two countdowns turn over together and the page runs
// one timeout however many timers it shows, and none while no countdown is
// running. It ticks on the wall clock's whole seconds, where a countdown's
// digits change.

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let current = 0;
let pending: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  // The next whole second, never sooner than a millisecond away.
  pending = setTimeout(tick, Math.max(1, 1000 - (Date.now() % 1000)));
}

function tick(): void {
  current = Date.now();
  for (const listener of Array.from(listeners)) listener(current);
  if (listeners.size > 0) schedule();
  else pending = null;
}

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    current = Date.now();
    schedule();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
  };
}

/** The page clock's time, in epoch milliseconds: the last tick while it runs. */
function pageNow(): number {
  return listeners.size > 0 ? current : Date.now();
}

/**
 * The page clock, read by a component: the time now, updated on each whole
 * second while `running` (a countdown on screen is moving), and read once
 * otherwise (a paused timer does not move).
 */
export function usePageClock(running: boolean): number {
  const [now, setNow] = useState(pageNow);
  // Before paint: a timer that starts running (a paused one resumed) is
  // drawn at the time now on its first frame, not at the time it mounted,
  // and its bar never sweeps from a stale share.
  useLayoutEffect(() => {
    if (!running) return undefined;
    setNow(pageNow());
    return subscribe(setNow);
  }, [running]);
  return now;
}
