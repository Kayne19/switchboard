import { useCallback, useEffect, useRef } from 'react';

/** `run` at most once an animation frame (scroll events come faster): a
 * call while a frame is pending is dropped; a frame pending at unmount is
 * cancelled. */
export function useOncePerFrame(run: () => void): () => void {
  const frame = useRef<number | null>(null);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  return useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      run();
    });
  }, [run]);
}
