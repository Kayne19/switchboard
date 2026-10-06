import { AnimatePresence, motion } from 'motion/react';
import type { KeyboardEvent } from 'react';
import type { MetricData, SceneObject } from '../controller/types';

interface MetricsPrimitiveProps {
  metrics: Array<SceneObject<MetricData>>;
  variant?: 'list' | 'primary' | 'rail';
  onFocus?: (id: string) => void;
}

const ARROWS = {
  up: 'M6 10.5 V2.2 M2.4 5.8 L6 2.2 L9.6 5.8',
  down: 'M6 1.5 V9.8 M2.4 6.2 L6 9.8 L9.6 6.2',
  flat: 'M1.5 6 H10.5 M7 2.4 L10.5 6 L7 9.6',
} as const;

/** The metric's trend arrow, which a to-do list's priority reuses (up for high, down for low). */
export function ArrowGlyph({ direction, className, label }: { direction: keyof typeof ARROWS; className: string; label: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" role="img" aria-label={label}>
      <path d={ARROWS[direction]} />
    </svg>
  );
}

// Which way the value moved, beside it in its own colour: an arrow for the
// trend, then the delta as the agent worded it. Either may come alone.
function MetricTrend({ data }: { data: MetricData }) {
  if (data.trend === undefined && data.delta === undefined) return null;
  return (
    <span className="metric-row__trend" data-testid="metric-trend" data-trend={data.trend}>
      {data.trend ? <ArrowGlyph direction={data.trend} className="metric-row__arrow" label={data.trend} /> : null}
      {data.delta ? <span className="metric-row__delta">{data.delta}</span> : null}
    </span>
  );
}

export function MetricsPrimitive({ metrics, variant = 'list', onFocus }: MetricsPrimitiveProps) {
  if (variant === 'rail' && metrics.length === 0) {
    return null;
  }
  const isCluster = variant === 'primary' && metrics.length > 1;

  // A metric in a cluster expands itself: it marks the click or key handled
  // and lets it bubble (FocusableSurface's rule), so the page still hears
  // the click as a gesture.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onFocus?.(id);
  };

  return (
    <motion.div
      className={`metrics metrics--${variant}${isCluster ? ' metrics--cluster' : ''}`}
      data-count={metrics.length}
      layout
      data-testid="metrics"
    >
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
                    e.preventDefault();
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
              <span className="metric-row__number">{metric.data.value}</span>
              <MetricTrend data={metric.data} />
            </motion.span>
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
