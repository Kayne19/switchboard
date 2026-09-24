import { motion } from 'motion/react';
import type { ProgressData } from '../controller/types';
export function ProgressPrimitive({ data }: { data: ProgressData }) {
  const percentage = Math.min(100, Math.max(0, data.value));
  return <div className="progress-primitive" data-testid="progress"><div className="progress-primitive__label"><strong>{data.label}</strong><span className="tech micro muted">{data.detail}</span></div><div className="progress-primitive__track" role="progressbar" aria-label={data.text ?? `${Math.round(percentage)} percent`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><motion.div className="progress-primitive__fill" initial={{ width: '0%' }} animate={{ width: `${percentage}%` }} transition={{ duration: 0.54, ease: [0.22,0.61,0.36,1] }}/></div><div className="progress-primitive__text tech micro">{data.text ?? `${Math.round(percentage)}% COMPLETE`}</div></div>;
}
