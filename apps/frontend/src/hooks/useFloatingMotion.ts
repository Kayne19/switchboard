import { useAnimationFrame, useMotionValue, useReducedMotion } from 'motion/react';
import { useRef } from 'react';

export function useFloatingMotion({
  listening,
  amplitude = 4,
  idleCycleSeconds = 6.8,
  activeCycleSeconds = 2.2,
}: {
  listening: boolean;
  amplitude?: number;
  idleCycleSeconds?: number;
  activeCycleSeconds?: number;
}) {
  const y = useMotionValue(0);
  const rotate = useMotionValue(0);
  const phase = useRef(0);
  const speed = useRef((Math.PI * 2) / idleCycleSeconds);
  const reduced = useReducedMotion();

  useAnimationFrame((_time, delta) => {
    if (reduced) {
      y.set(0);
      rotate.set(0);
      return;
    }
    const targetSpeed = (Math.PI * 2) / (listening ? activeCycleSeconds : idleCycleSeconds);
    const smoothing = 1 - Math.exp(-delta / 340);
    speed.current += (targetSpeed - speed.current) * smoothing;
    phase.current += speed.current * (delta / 1000);
    const activeAmplitude = listening ? amplitude * 1.55 : amplitude;
    y.set(Math.sin(phase.current) * activeAmplitude);
    rotate.set(Math.sin(phase.current) * 0.11);
  });

  return { y, rotate };
}
