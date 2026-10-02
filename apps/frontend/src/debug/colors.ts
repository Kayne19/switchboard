import { OPERATOR, UTILITY } from './reducer';

const PROJECT_COLORS = ['#3ef0ff', '#ff5fd2', '#c6ff4a', '#ff9e3d', '#7aa2ff', '#4dffc3', '#ffd84d'];

export const STAGE_COLORS = {
  caller: '#e8f1ff',
  jev: '#3ef0ff',
  utility: '#b48cff',
  operator: '#5dffa8',
  floor: '#ffb547',
} as const;

/** One steady colour per agent: fixed for the two service agents, by order for projects. */
export function agentColor(agent: string, order: readonly string[]): string {
  if (agent === OPERATOR) return STAGE_COLORS.operator;
  if (agent === UTILITY) return STAGE_COLORS.utility;
  const projects = order.filter((name) => name !== OPERATOR && name !== UTILITY);
  const index = Math.max(0, projects.indexOf(agent));
  return PROJECT_COLORS[index % PROJECT_COLORS.length];
}
