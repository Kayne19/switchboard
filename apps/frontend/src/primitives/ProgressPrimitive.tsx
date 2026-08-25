import { motion } from 'motion/react';
import type { ProgressData } from '../controller/types';
export function ProgressPrimitive({ data }: { data: ProgressData }) {
  const value = Math.min(1, Math.max(0, data.value));
  return <div className="progress-primitive" data-testid="progress"><div className="progress-primitive__label"><strong>{data.label}</strong><span className="tech micro muted">{data.detail}</span></div><div className="progress-primitive__track" aria-label={data.text ?? `${Math.round(value*100)} percent`}><motion.div className="progress-primitive__fill" initial={{ scaleX: 0 }} animate={{ scaleX: value }} transition={{ duration: 0.54, ease: [0.22,0.61,0.36,1] }}/></div><div className="progress-primitive__text tech micro">{data.text ?? `${Math.round(value*100)}% COMPLETE`}</div></div>;
}
