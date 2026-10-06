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
