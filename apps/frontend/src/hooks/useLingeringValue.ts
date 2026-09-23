import { useEffect, useRef, useState } from 'react';

// How long a finished tool stays named -- in the presence caption and in the
// activity panel alike, so the two surfaces change together -- so a run of
// short calls reads as one steady status.
export const ACTIVITY_LINGER_MS = 1200;
export const ACTIVITY_MINIMUM_MS = 1600;

// Takes a new value at once, and keeps showing the last one for `lingerMs`
// after the value goes away. A status that starts and stops in quick
// succession -- one tool call after another -- then updates in place instead
// of flickering between its text and nothing.
export function useLingeringValue<T>(value: T | null, lingerMs: number, minimumMs = 0): T | null {
  const [lastShown, setLastShown] = useState<T | null>(value);
  const shownAt = useRef(value === null ? 0 : Date.now());
  useEffect(() => {
    if (value !== null) {
      shownAt.current = Date.now();
      setLastShown(value);
      return;
    }
    if (lastShown === null) {
      return;
    }
    const minimumRemaining = Math.max(0, minimumMs - (Date.now() - shownAt.current));
    const timer = setTimeout(() => setLastShown(null), Math.max(lingerMs, minimumRemaining));
    return () => clearTimeout(timer);
  }, [value, lingerMs, minimumMs, lastShown]);
  return value ?? lastShown;
}
