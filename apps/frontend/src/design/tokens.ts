export const palette = {
  black: '#000000',
  red: '#C61522',
  orange: '#F15A24',
  amber: '#FFB000',
  green: '#7FD63D',
  cyan: '#5ED6D8',
  paper: '#E8E6DF',
  muted: '#8C8C86',
  dim: '#3E3E3A',
} as const;

export const motionDurations = {
  reveal: 0.34,
  dismiss: 0.22,
  recompose: 0.42,
  focus: 0.46,
} as const;

export const sceneOrder = ['idle', 'conversation', 'training', 'architecture', 'email', 'code'] as const;
