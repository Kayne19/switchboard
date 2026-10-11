// A line as the call runtime reports it (`LineControls` in
// src/controller/context.tsx), for the tests that register a voice runtime:
// a project on the line, two others, two models and two thinking levels,
// nothing locked. Its four controls are spies.
import { vi } from 'vitest';
import type { LineControls } from '../../src/controller/context';

export function testLine(overrides: Partial<LineControls> = {}): LineControls {
  return {
    connected: true,
    route: 'switchboard',
    routeLabel: 'switchboard',
    routes: [{ value: 'operator', label: 'Operator' }, { value: 'switchboard', label: 'switchboard' }, { value: 'homelab', label: 'homelab' }],
    model: 'openai/gpt-5',
    models: [{ value: 'openai/gpt-5', label: 'openai/gpt-5' }, { value: 'anthropic/claude', label: 'anthropic/claude' }],
    modelTitle: '',
    thinking: 'high',
    thinkingLevels: [{ value: 'low', label: 'thinking: low' }, { value: 'high', label: 'thinking: high' }],
    onProject: true,
    routeDisabled: false,
    modelDisabled: false,
    thinkingDisabled: false,
    status: 'Ready.',
    statusError: false,
    selectRoute: vi.fn(),
    selectModel: vi.fn(),
    selectThinking: vi.fn(),
    hangup: vi.fn(),
    ...overrides,
  };
}
