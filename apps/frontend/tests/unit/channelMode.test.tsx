// @vitest-environment jsdom
// The CHANNEL / MODE stack in every page's bottom-left corner (#180). The
// scene shell draws it once, so no composition carries its own: the
// conversation page had a static stack that always read PUSH-TO-TALK, and
// every content page a `DISPLAY / ...` label there instead.
//
// MODE is the page's one hands-free control. It reads the mode from the
// registered voice runtime (`CallRuntime`'s hands-free state) and switches
// it through that runtime's `toggleHandsFree`; the page owns no listening
// state of its own. In demo mode there is no runtime, so there is nothing
// to switch and the control says so.
import { act, useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { sceneKind, type SceneKind } from '../../src/app/sceneModel';
import { useController, type VoiceRuntime } from '../../src/controller/context';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { WAKE_PHRASE } from '../../src/hands_free';
import { controllerState, lastScene, renderScene, stubResizeObserver } from './sceneHarness';

const composed: ControllerAction[] = [
  { op: 'show', id: 'latency', type: 'metric', role: 'primary', data: { label: 'P95 LATENCY', value: '182 ms' } },
  { op: 'show', id: 'latency-note', type: 'note', data: { tag: 'NOTE / 01', segments: [{ text: 'Up since the deploy.' }] } },
];

const scenes: Array<[SceneKind, ControllerAction[]]> = [
  ['idle', fixtures.idle],
  ['conversation', fixtures.conversation],
  ['training', fixtures.training],
  ['architecture', fixtures.architecture],
  ['document', fixtures.email],
  ['code', fixtures.code],
  ['table', fixtures.results],
  ['image', fixtures.figure],
  ['composed', composed],
];

stubResizeObserver();

/** A voice runtime registered before the scene's actions run. */
function Voice({ runtime }: { runtime: VoiceRuntime }) {
  const { registerVoiceRuntime } = useController();
  useEffect(() => registerVoiceRuntime(runtime), [registerVoiceRuntime, runtime]);
  return null;
}

function voiceRuntime(over: Partial<VoiceRuntime> = {}): VoiceRuntime {
  return { toggleTurn: () => {}, sendText: () => true, handsFree: false, toggleHandsFree: () => {}, ...over };
}

// The scene just drawn: the page a fixture replaces stays mounted until its
// exit ends, and carries the stack it was drawn with.
const stack = () => lastScene().querySelectorAll('.channel-stack');
const mode = () => lastScene().querySelector<HTMLButtonElement>('.channel-stack__mode')!;

describe('the CHANNEL / MODE stack', () => {
  it.each(scenes)('stands once in the bottom-left corner of the %s page', (kind, actions) => {
    renderScene(actions, <Voice runtime={voiceRuntime()} />);
    expect(sceneKind(controllerState())).toBe(kind);
    expect(stack()).toHaveLength(1);
    expect(stack()[0].textContent).toBe('CHANNEL / VOICEMODE / PUSH-TO-TALK');
    // No page carries a second one, and none labels the corner itself.
    expect(lastScene().querySelector('.conversation-channel')).toBeNull();
    for (const footer of lastScene().querySelectorAll('.scene-footer')) {
      expect(footer.querySelectorAll('span')).toHaveLength(1);
    }
  });

  it('is a control the keyboard reaches, named for what it switches', () => {
    renderScene(fixtures.idle, <Voice runtime={voiceRuntime()} />);
    const button = mode();
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toBe('MODE / PUSH-TO-TALK');
    // The stack is read, not hidden from the accessibility tree.
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('switches the voice runtime between push-to-talk and hands-free', () => {
    const toggleHandsFree = vi.fn();
    renderScene(fixtures.conversation, <Voice runtime={voiceRuntime({ toggleHandsFree })} />);
    act(() => mode().click());
    expect(toggleHandsFree).toHaveBeenCalledTimes(1);
  });

  it('reads the wake word while the runtime reports hands-free listening', () => {
    renderScene(fixtures.conversation, <Voice runtime={voiceRuntime({ handsFree: true })} />);
    expect(mode().textContent).toBe(`MODE / HANDS-FREE \u00b7 ${WAKE_PHRASE.toUpperCase()}`);
    expect(mode().getAttribute('aria-pressed')).toBe('true');
  });

  it('has nothing to switch with no voice runtime: the demo page refuses it', () => {
    renderScene(fixtures.conversation);
    expect(mode().disabled).toBe(true);
    expect(mode().textContent).toBe('MODE / PUSH-TO-TALK');
  });
});
