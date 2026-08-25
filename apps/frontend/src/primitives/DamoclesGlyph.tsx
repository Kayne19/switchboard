import { motion, useReducedMotion } from 'motion/react';

export function DamoclesGlyph({ className, glint = false, title }: { className?: string; glint?: boolean; title?: string }) {
  const reduced = useReducedMotion();
  return (
    <svg className={className} viewBox="0 0 944 1133" role={title ? 'img' : 'presentation'} aria-label={title} shapeRendering="geometricPrecision">
      <defs>
        <clipPath id="damocles-blade-clip">
          <polygon points="393,465 440,512 440,976 393,929" />
          <polygon points="461,533 479,551 479,1015 461,997" />
        </clipPath>
        <linearGradient id="damocles-glint" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.45" stopColor="white" stopOpacity="0.1" />
          <stop offset="0.52" stopColor="white" stopOpacity="0.95" />
          <stop offset="0.59" stopColor="white" stopOpacity="0.1" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g fill="currentColor">
        <polygon points="393,465 440,512 440,976 393,929" />
        <polygon points="461,533 479,551 479,1015 461,997" />
        <polygon points="442,176 460,176 460,441 442,423" />
        <polygon points="451,75 435,106 405,135 428,155 442,181 460,181 474,155 497,135 467,106" />
        <polygon points="235,327 335,327 707,699 641,699 335,393 301,393" />
      </g>
      <polygon points="451,115 467,135 451,154 435,135" fill="#000000" />
      {glint && !reduced ? (
        <g clipPath="url(#damocles-blade-clip)">
          <motion.rect
            x="340" y="380" width="190" height="92" fill="url(#damocles-glint)"
            initial={{ y: 0, opacity: 0 }}
            animate={{ y: [0, 610], opacity: [0, 0.9, 0] }}
            transition={{ duration: 1.05, times: [0, 0.48, 1], ease: 'easeInOut', repeat: Infinity, repeatDelay: 13.5 }}
          />
        </g>
      ) : null}
    </svg>
  );
}
