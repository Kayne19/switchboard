import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { clampAudioLevel, smoothAudioLevel } from '../runtime/audioLevel';

const heights = [5,10,16,8,19,12,7,17,11,6,15,9,18,7,12,5];
const barProfiles = [0.55, 0.82, 1, 0.68, 1, 0.76, 0.58, 0.92, 0.72, 0.55, 0.88, 0.66, 0.96, 0.6, 0.78, 0.52];

/** Map one live RMS value to a stable, slightly varied bar scale. */
export function mapVoiceLevelToBar(level: number, index: number): number {
  const profile = barProfiles[index % barProfiles.length];
  return 0.2 + clampAudioLevel(level) * (0.45 + profile * 0.55);
}

export function VoiceIndicator({ compact = false, getLevel }: { compact?: boolean; getLevel?: () => number }) {
  const barsRef = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    if (!getLevel) return;
    let frame: number | null = null;
    let smoothed = 0;
    const update = () => {
      smoothed = smoothAudioLevel(smoothed, getLevel());
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const scale = mapVoiceLevelToBar(smoothed, index);
        bar.style.transform = `scaleY(${scale})`;
        bar.style.opacity = String(0.35 + scale * 0.65);
      });
      frame = requestAnimationFrame(update);
    };
    update();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [getLevel]);

  return (
    <motion.div
      className={`voice-indicator${compact ? ' voice-indicator--compact' : ''}`}
      initial={{ opacity: 0, clipPath: 'inset(0 44% 0 44%)', scaleX: 0.65 }}
      animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0%)', scaleX: 1 }}
      exit={{ opacity: 0, clipPath: 'inset(0 48% 0 48%)', scaleX: 0.55 }}
      transition={{ duration: 0.26, ease: [0.22,0.61,0.36,1] }}
      aria-label="Voice stream active"
    >
      <div className="voice-indicator__bars" aria-hidden="true">
        {heights.map((height,index) => (
          <motion.i
            key={index}
            ref={(element) => { barsRef.current[index] = element; }}
            style={{ height }}
            animate={getLevel ? undefined : { scaleY: [0.3,1,0.48,0.78,0.3], opacity: [0.35,0.95,0.58,0.78,0.35] }}
            transition={getLevel ? undefined : { duration: 1.05, ease: 'easeInOut', repeat: Infinity, delay: -((index * 0.13) % 0.9) }}
          />
        ))}
      </div>
      <div className="voice-indicator__label tech micro">VOICE STREAM / ACTIVE</div>
    </motion.div>
  );
}
