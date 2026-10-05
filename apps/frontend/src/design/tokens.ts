export const sceneOrder = ['idle', 'conversation', 'training', 'architecture', 'email', 'code', 'results', 'handoff', 'comparison', 'figure', 'plan', 'composed', 'topology', 'pipeline', 'trace'] as const;

// The page's smallest type, in CSS pixels: the floors of the two small
// faces in styles/index.css (`.micro` clamps from 7px, `.tech` from 8px).
// A drawing scaled to its frame keeps every line of its text at or above
// them (primitives/drawingFit.ts); a test holds the two in step.
export const TYPE_FLOOR_PX = { micro: 7, tech: 8 } as const;
