// Frame geometry is copied from the approved composition,
// reference/lineage/approved-v16-controller.html; each variant names the
// element it was taken from. Changing a path here is a design change, not a
// refactor.
//
// Frames resolve with a CSS fade rather than a Motion path-length trace:
// path length is measured in user space, but these strokes are
// non-scaling, and the dash pattern Motion writes to trace them breaks on
// exactly that mismatch.

interface FramePath {
  d: string;
  stroke: string;
  width?: number;
}

interface FrameSpec {
  viewBox: string;
  paths: FramePath[];
}

const ORANGE = (alpha: number) => `rgba(var(--orange-rgb), ${alpha})`;
const PAPER = (alpha: number) => `rgba(232, 230, 223, ${alpha})`;

const frames = {
  // #training .frame: the chart instrument frame, also the default content frame.
  panel: {
    viewBox: '0 0 1000 620',
    paths: [
      { d: 'M0 36 V0 H788 L812 24 H1000 V78', stroke: ORANGE(0.64), width: 1.2 },
      { d: 'M1000 128 V620 H922', stroke: ORANGE(0.34) },
      { d: 'M864 620 H112 L88 596 H0 V532', stroke: PAPER(0.32) },
      { d: 'M0 478 V126', stroke: PAPER(0.15) },
    ],
  },
  // #email .email-frame
  document: {
    viewBox: '0 0 1000 800',
    paths: [
      { d: 'M0 52 V0 H792 L820 28 H1000 V110', stroke: ORANGE(0.55) },
      { d: 'M1000 162 V800 H900', stroke: PAPER(0.2) },
      { d: 'M845 800 H126 L98 772 H0 V700', stroke: PAPER(0.23) },
      { d: 'M0 640 V132', stroke: PAPER(0.12) },
    ],
  },
  // #code .code-border, the interrupted rails. CodeViewport clips its scroll
  // region to the inside of this outline.
  code: {
    viewBox: '0 0 1000 700',
    paths: [
      { d: 'M2 88 V2 H245 M306 2 H864 L902 40 H998 V102', stroke: ORANGE(0.55) },
      { d: 'M998 162 V566 M998 626 V698 H806 M744 698 H172 L142 668 H2 V602', stroke: PAPER(0.17) },
      { d: 'M2 536 V154', stroke: PAPER(0.12) },
    ],
  },
  // The architecture graph's rails: a diagram gets no box, only a stepped
  // line above and below it.
  rails: {
    viewBox: '0 0 1200 700',
    paths: [
      { d: 'M40 42 H552 L588 70 H1155', stroke: PAPER(0.1) },
      { d: 'M70 652 H900 L936 624 H1160', stroke: PAPER(0.1) },
    ],
  },
} satisfies Record<string, FrameSpec>;

export type FrameVariant = keyof typeof frames | 'answer';

// #conversation .answer-shell: the one closed frame, cut at two corners, with
// an edge that runs from orange to green and a dark fill of its own.
function AnswerFrame({ className }: { className?: string }) {
  return (
    <svg className={`tech-frame tech-frame--answer ${className ?? ''}`} viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="tech-frame-answer-edge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: ORANGE(0.62) }} />
          <stop offset="0.42" style={{ stopColor: ORANGE(0.18) }} />
          <stop offset="0.7" style={{ stopColor: PAPER(0.25) }} />
          <stop offset="1" style={{ stopColor: 'rgba(127, 214, 61, 0.28)' }} />
        </linearGradient>
      </defs>
      <path
        className="tech-frame__path"
        d="M0 0 H952 L1000 65 V500 H54 L0 425 Z"
        style={{ fill: 'rgba(4, 4, 4, 0.76)', stroke: 'url(#tech-frame-answer-edge)' }}
      />
    </svg>
  );
}

export function TechFrame({ variant = 'panel', className }: { variant?: FrameVariant; className?: string }) {
  if (variant === 'answer') return <AnswerFrame className={className} />;
  const frame: FrameSpec = frames[variant];
  return (
    <svg className={`tech-frame ${className ?? ''}`} viewBox={frame.viewBox} preserveAspectRatio="none" aria-hidden="true">
      {frame.paths.map((path, index) => (
        <path
          className="tech-frame__path"
          key={path.d}
          d={path.d}
          style={{ stroke: path.stroke, strokeWidth: path.width ?? 1, animationDelay: `${index * 70}ms` }}
        />
      ))}
    </svg>
  );
}
