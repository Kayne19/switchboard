// @vitest-environment jsdom
// The system view (#277): an agent's view("system") gives the stage to the
// line: who is on it, and the route, model and thinking pickers and the
// hangup the call runtime holds (`selectRoute`, `selectModel`,
// `selectThinking`, `hangup` in runtime/callRuntime.ts), which no page drew
// before. The view draws what the runtime reports and acts only through it;
// EXIT leaves for auto. On the demo page there is no line, and it says so.
import { act, useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { deriveScreenState } from '../../src/app/sceneModel';
import { useController, type LineControls } from '../../src/controller/context';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { testLine } from './lineControls';
import { controllerState, renderScene, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const system: ControllerAction = { op: 'set_view', view: 'system' };

const line = testLine;

/** Registers a voice runtime holding `controls`, as runtime.tsx does on a call. */
function OnCall({ controls }: { controls: LineControls }) {
  const { registerVoiceRuntime } = useController();
  useEffect(() => {
    registerVoiceRuntime({ toggleTurn: () => {}, sendText: () => true, handsFree: false, toggleHandsFree: () => {}, line: controls });
    return () => registerVoiceRuntime(null);
  }, [controls, registerVoiceRuntime]);
  return null;
}

const stage = () => document.querySelector('.stage')!;
const panel = () => document.querySelector('[data-scene="system"] .system')!;
const select = (name: string) => panel().querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;

function choose(element: HTMLSelectElement, value: string) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('the system view', () => {
  it('draws the line, its pickers and the hangup, and reports system, on an empty stage and over a visual', () => {
    const controls = line();
    renderScene([...fixtures.training, system], <OnCall controls={controls} />);
    expect(stage().getAttribute('data-scene-kind')).toBe('system');
    expect(panel().querySelector('.system__who')!.textContent).toContain('switchboard');
    expect([...select('route').options].map((option) => option.value)).toEqual(['operator', 'switchboard', 'homelab']);
    expect(select('route').value).toBe('switchboard');
    expect(select('model').value).toBe('openai/gpt-5');
    expect(select('thinking').value).toBe('high');
    expect(panel().querySelector('.system__hangup')).not.toBeNull();
    expect(panel().querySelector('[role="status"]')!.textContent).toContain('Ready.');
    // The visual on stage is not drawn: the line has the stage.
    expect(document.querySelector('.chart-primitive')).toBeNull();
    expect(document.querySelectorAll('[data-scene="system"] .channel-stack')).toHaveLength(1);
    expect(document.querySelectorAll('[data-scene="system"] [data-testid="damocles-presence"]')).toHaveLength(1);
    expect(deriveScreenState(controllerState(), 1).view).toBe('system');
  });

  it('acts only through the runtime: each picker and the hangup call its control', () => {
    const controls = line();
    renderScene([system], <OnCall controls={controls} />);
    choose(select('route'), 'homelab');
    expect(controls.selectRoute).toHaveBeenCalledWith('homelab');
    choose(select('model'), 'anthropic/claude');
    expect(controls.selectModel).toHaveBeenCalledWith('anthropic/claude');
    choose(select('thinking'), 'low');
    expect(controls.selectThinking).toHaveBeenCalledWith('low');
    act(() => panel().querySelector<HTMLButtonElement>('.system__hangup')!.click());
    expect(controls.hangup).toHaveBeenCalledTimes(1);
  });

  it('locks what the runtime locks, and says why a model cannot be picked', () => {
    renderScene([system], <OnCall controls={line({ routeDisabled: true, modelDisabled: true, modelTitle: 'Model catalog unavailable', thinkingDisabled: true })} />);
    expect(select('route').disabled).toBe(true);
    expect(select('model').disabled).toBe(true);
    expect(select('model').title).toBe('Model catalog unavailable');
    expect(select('thinking').disabled).toBe(true);
  });

  it('locks every control while the line is down, and shows a line error as one', () => {
    renderScene([system], <OnCall controls={line({ connected: false, status: 'Connection error.', statusError: true })} />);
    for (const name of ['route', 'model', 'thinking']) expect(select(name).disabled, name).toBe(true);
    expect(panel().querySelector<HTMLButtonElement>('.system__hangup')!.disabled).toBe(true);
    const status = panel().querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Connection error.');
    expect(status.classList.contains('system__status--error')).toBe(true);
  });

  it('says there is no line on the demo page, with nothing to switch', () => {
    renderScene([system]);
    expect(panel().textContent).toContain('NO CALL');
    expect(panel().querySelectorAll('select, .system__hangup')).toHaveLength(0);
    expect(deriveScreenState(controllerState(), 1).view).toBe('system');
  });

  it('leaves for auto on EXIT, and the report says so', () => {
    renderScene([...fixtures.code, system], <OnCall controls={line()} />);
    act(() => panel().querySelector<HTMLButtonElement>('.system__exit')!.click());
    expect(stage().getAttribute('data-scene-kind')).toBe('code');
    expect(deriveScreenState(controllerState(), 1).view).toBe('auto');
  });
});
