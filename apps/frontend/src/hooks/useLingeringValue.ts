import { useEffect, useState } from 'react';

// How long a finished tool stays named -- in the presence caption and in the
// activity panel alike, so the two surfaces change together -- so a run of
// short calls reads as one steady status.
export const ACTIVITY_LINGER_MS = 1200;

// Takes a new value at once, and keeps showing the last one for `lingerMs`
// after the value goes away. A status that starts and stops in quick
// succession -- one tool call after another -- then updates in place instead
// of flickering between its text and nothing.
export function useLingeringValue<T>(value: T | null, lingerMs: number): T | null {
  const [lastShown, setLastShown] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      setLastShown(value);
      return;
    }
    const timer = setTimeout(() => setLastShown(null), lingerMs);
    return () => clearTimeout(timer);
  }, [value, lingerMs]);
  return value ?? lastShown;
}
