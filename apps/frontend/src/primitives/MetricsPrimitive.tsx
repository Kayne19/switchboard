import { AnimatePresence, motion } from 'motion/react';
import type { MetricData, SceneObject } from '../controller/types';

interface MetricsPrimitiveProps {
  metrics: Array<SceneObject<MetricData>>;
  variant?: 'list' | 'primary';
}

export function MetricsPrimitive({ metrics, variant = 'list' }: MetricsPrimitiveProps) {
  return (
    <motion.div className={`metrics metrics--${variant}`} layout data-testid="metrics">
      <AnimatePresence mode="popLayout" initial={false}>
        {metrics.map((metric) => (
          <motion.div
            className="metric-row"
            key={metric.id}
            layout
            initial={{ opacity: 0, x: 12, filter: 'blur(5px)' }}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: 10, filter: 'blur(5px)' }}
            transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <span className="metric-row__label tech micro">{metric.data.label}</span>
            <motion.span
              className={`metric-row__value semantic-${metric.data.semantic ?? 'paper'}`}
              key={`${metric.id}-${metric.data.value}`}
              initial={{ opacity: 0.35, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
            >
              {metric.data.value}
            </motion.span>
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
