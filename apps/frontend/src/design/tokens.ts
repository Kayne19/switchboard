import type { Semantic } from '../controller/types';

export const sceneOrder = ['idle', 'conversation', 'training', 'architecture', 'email', 'code', 'results', 'handoff', 'comparison', 'figure', 'plan', 'composed', 'topology', 'pipeline', 'trace', 'calendar', 'calendar-day', 'calendar-month', 'calendar-agenda', 'tasks', 'timer', 'weather', 'inbox', 'today'] as const;

// Each semantic colour as a drawing sets it in an attribute (the stylesheet's tokens).
export const SEMANTIC_COLOR: Record<Semantic, string> = {
  red: 'var(--red)',
  orange: 'var(--orange)',
  green: 'var(--green)',
  cyan: 'var(--cyan)',
  amber: 'var(--amber)',
  paper: 'var(--paper)',
  muted: 'var(--muted)',
};

// The page's smallest type, in CSS pixels: the floors of the two small
// faces in styles/index.css (`.micro` clamps from 7px, `.tech` from 8px).
// A drawing scaled to its frame keeps every line of its text at or above
// them (primitives/drawingFit.ts); a test holds the two in step.
export const TYPE_FLOOR_PX = { micro: 7, tech: 8 } as const;

// The page's monospace face sets every glyph 0.6em wide, and letter-spacing
// adds its tracking after each, so a line in it is as wide as its
// characters times this advance, in the units of its size. A layout that
// sizes a box to its text before drawing it (jsdom measures no text) takes
// the advance from here, with the size and tracking of the stylesheet rule
// that sets the text; a test holds each in step with styles/index.css.
// `roundUp` rounds it up to a tenth, as the boxes drawn so far were sized.
const MONO_EM = 0.6;

export function monoAdvance(size: number, trackingEm: number, { roundUp = false }: { roundUp?: boolean } = {}): number {
  // Held to a millionth of an em, so 0.6 + 0.08 is 0.68, not 0.6799999999999999.
  const advance = size * (Math.round((MONO_EM + trackingEm) * 1e6) / 1e6);
  return roundUp ? Math.ceil(advance * 10) / 10 : advance;
}
