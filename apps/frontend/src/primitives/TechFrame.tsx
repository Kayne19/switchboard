import { motion, useReducedMotion } from 'motion/react';
const paths = {
  panel: 'M 2 26 L 2 2 L 912 2 L 998 62 L 998 498 L 58 498 L 2 442 Z',
  document: 'M 2 20 L 2 2 L 940 2 L 998 60 L 998 498 L 78 498 L 2 432 Z',
  code: 'M 2 46 L 2 2 L 850 2 L 910 48 L 998 48 L 998 498 L 155 498 L 102 450 L 2 450 Z',
  open: 'M 2 120 L 2 2 L 350 2 M 650 2 L 998 2 L 998 170 M 998 330 L 998 498 L 690 498 M 310 498 L 2 498 L 2 380',
};
export function TechFrame({ variant = 'panel', className }: { variant?: keyof typeof paths; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <svg className={`tech-frame ${className ?? ''}`} viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true">
      <motion.path d={paths[variant]} fill="none" stroke="rgba(var(--orange-rgb), .58)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" initial={reduced ? undefined : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} exit={reduced ? undefined : { pathLength: 0, opacity: 0 }} transition={{ duration: 0.36, ease: [0.22,0.61,0.36,1] }} />
      <path d="M 2 78 L 2 142 M 998 94 L 998 166 M 928 498 L 984 498" fill="none" stroke="rgba(232,230,223,.18)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
