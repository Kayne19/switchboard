import { motion } from 'motion/react';
const heights = [5,10,16,8,19,12,7,17,11,6,15,9,18,7,12,5];
export function VoiceIndicator({ compact = false }: { compact?: boolean }) {
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
          <motion.i key={index} style={{ height }} animate={{ scaleY: [0.3,1,0.48,0.78,0.3], opacity: [0.35,0.95,0.58,0.78,0.35] }} transition={{ duration: 1.05, ease: 'easeInOut', repeat: Infinity, delay: -((index * 0.13) % 0.9) }} />
        ))}
      </div>
      <div className="voice-indicator__label tech micro">VOICE STREAM / ACTIVE</div>
    </motion.div>
  );
}
