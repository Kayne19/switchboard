import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { clampAudioLevel, smoothAudioLevel } from '../runtime/audioLevel';
import { prefersReducedMotion } from './reducedMotion';

const heights = [5,10,16,8,19,12,7,17,11,6,15,9,18,7,12,5];
const barProfiles = [0.55, 0.82, 1, 0.68, 1, 0.76, 0.58, 0.92, 0.72, 0.55, 0.88, 0.66, 0.96, 0.6, 0.78, 0.52];

/** Map one live RMS value to a stable, slightly varied bar scale. */
export function mapVoiceLevelToBar(level: number, index: number): number {
  const profile = barProfiles[index % barProfiles.length];
  return clampAudioLevel(0.2 + clampAudioLevel(level) * (0.45 + profile * 0.55));
}

export function VoiceIndicator({ compact = false, getLevel }: { compact?: boolean; getLevel?: () => number | null }) {
  const liveAtMount = getLevel?.() ?? null;
  const [levelReady, setLevelReady] = useState(liveAtMount !== null);
  const barsRef = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    if (!getLevel) return;
    // A call has a level source, so the bars start flat and stay flat until
    // it reports something: the canned loop is for a page with no voice
    // runtime at all (the demo scenes). On WebKit the playback analyser is
    // unavailable, and the caller watched the canned loop run through the
    // whole call -- it told them nothing about who was speaking (#189).
    for (const [index, bar] of barsRef.current.entries()) {
      if (!bar || bar.style.transform) continue;
      const scale = mapVoiceLevelToBar(0, index);
      bar.style.transform = `scaleY(${scale})`;
      bar.style.opacity = String(0.35 + scale * 0.65);
    }
    if (prefersReducedMotion()) return;
    let frame: number | null = null;
    let smoothed = 0;
    const update = () => {
      const level = getLevel();
      if (level === null) {
        frame = requestAnimationFrame(update);
        return;
      }
      if (!levelReady) setLevelReady(true);
      smoothed = smoothAudioLevel(smoothed, level);
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
  }, [getLevel, levelReady]);

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
            animate={levelReady || getLevel ? undefined : { scaleY: [0.3,1,0.48,0.78,0.3], opacity: [0.35,0.95,0.58,0.78,0.35] }}
            transition={levelReady || getLevel ? undefined : { duration: 1.05, ease: 'easeInOut', repeat: Infinity, delay: -((index * 0.13) % 0.9) }}
          />
        ))}
      </div>
      <div className="voice-indicator__label tech micro">VOICE STREAM / ACTIVE</div>
    </motion.div>
  );
}
