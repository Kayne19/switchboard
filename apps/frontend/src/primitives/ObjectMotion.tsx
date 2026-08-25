import { motion, type HTMLMotionProps } from 'motion/react';
import type { ReactNode } from 'react';
export function ObjectMotion({ objectId, children, className, ...props }: Omit<HTMLMotionProps<'div'>,'children'> & { objectId: string; children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} layout layoutId={`switchboard-object-${objectId}`} initial={{ opacity: 0, filter: 'blur(8px)', clipPath: 'inset(48% 0 48% 0)' }} animate={{ opacity: 1, filter: 'blur(0px)', clipPath: 'inset(0% 0 0% 0)' }} exit={{ opacity: 0, filter: 'blur(7px)', clipPath: 'inset(48% 0 48% 0)' }} transition={{ opacity: { duration: 0.22 }, filter: { duration: 0.28 }, clipPath: { duration: 0.34, ease: [0.22,0.61,0.36,1] }, layout: { duration: 0.42, ease: [0.22,0.61,0.36,1] } }} {...props}>{children}</motion.div>
  );
}
