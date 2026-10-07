import { motion, type HTMLMotionProps } from 'motion/react';
import type { ReactNode } from 'react';
import { useFocusCopyHidden, useLayoutMotion } from '../hooks/useLayoutMotion';

/**
 * Where an entrance that resolves out of a blur ends: sharp, and with no
 * filter left on it. `blur(0px)` looks the same as none but is still a
 * filter, and Chrome draws a filtered box through a surface of its own or
 * not as its compositor decides from load to load: text at a fractional
 * position then lands a pixel higher or lower between two loads of the same
 * scene (the portrait list and calendar scenes did).
 */
export const SHARP = { filter: 'blur(0px)', transitionEnd: { filter: 'none' } } as const;

/** The object's box: its layout and layout identity go to motion through `useLayoutMotion`. */
function ObjectBox({ layout, layoutId, ...props }: HTMLMotionProps<'div'>) {
  const layoutMotion = useLayoutMotion({ layout, layoutId });
  return <motion.div {...layoutMotion} {...props} />;
}

export function ObjectMotion({ objectId, children, className, ...props }: Omit<HTMLMotionProps<'div'>,'children'> & { objectId: string; children: ReactNode; className?: string }) {
  // The slot copy of the focused object stands aside under reduced motion (`useFocusCopyHidden`).
  const focusCopy = useFocusCopyHidden(objectId);
  return (
    <ObjectBox className={className} data-focus-copy={focusCopy ? '' : undefined} layout layoutId={`switchboard-object-${objectId}`} initial={{ opacity: 0, filter: 'blur(8px)', clipPath: 'inset(48% 0 48% 0)' }} animate={{ opacity: 1, ...SHARP, clipPath: 'inset(0% 0 0% 0)' }} exit={{ opacity: 0, filter: 'blur(7px)', clipPath: 'inset(48% 0 48% 0)' }} transition={{ opacity: { duration: 0.22 }, filter: { duration: 0.28 }, clipPath: { duration: 0.34, ease: [0.22,0.61,0.36,1] }, layout: { duration: 0.42, ease: [0.22,0.61,0.36,1] } }} {...props}>{children}</ObjectBox>
  );
}
