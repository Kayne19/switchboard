import { AnimatePresence, motion } from 'motion/react';
import type { KeyboardEvent } from 'react';
import type { MetricData, SceneObject } from '../controller/types';

interface MetricsPrimitiveProps {
  metrics: Array<SceneObject<MetricData>>;
  variant?: 'list' | 'primary' | 'rail';
  onFocus?: (id: string) => void;
}

export function MetricsPrimitive({ metrics, variant = 'list', onFocus }: MetricsPrimitiveProps) {
  if (variant === 'rail' && metrics.length === 0) {
    return null;
  }
  const isRail = variant === 'rail';
  const isCluster = variant === 'primary' && metrics.length > 1;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    onFocus?.(id);
  };

  return (
    <motion.div
      className={`metrics metrics--${variant}${isCluster ? ' metrics--cluster' : ''}`}
      data-count={metrics.length}
      layout
      data-testid="metrics"
    >
      {isRail ? (
        <div className="metrics__header">
          <span className="metrics__tag tech micro">TELEMETRY</span>
          <span className="metrics__index tech muted">
            {metrics.length === 1 ? (metrics[0]?.data.caption ?? 'LIVE') : `${metrics.length} CHANNELS`}
          </span>
        </div>
      ) : null}
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
            role={isCluster ? 'button' : undefined}
            tabIndex={isCluster ? 0 : undefined}
            aria-label={isCluster ? `Expand metric ${metric.data.label}` : undefined}
            onClick={
              isCluster && onFocus
                ? (e) => {
                    e.stopPropagation();
                    onFocus(metric.id);
                  }
                : undefined
            }
            onKeyDown={isCluster && onFocus ? (e) => handleKeyDown(e, metric.id) : undefined}
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
