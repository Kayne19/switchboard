// @vitest-environment jsdom
// Verifier scratch (not committed): does the room the error takes go when the error goes?
import { describe, expect, it } from 'vitest';
import type { ControllerAction } from '../../src/controller/types';
import { RUNTIME_CONVERSATION_ID, RUNTIME_LINE_ERROR_ID } from '../../src/controller/types';
import { lastScene, renderScene, runActions, stubResizeObserver } from './sceneHarness';

stubResizeObserver();
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() { return (this as HTMLElement).classList.contains('channel-stack__error') ? 40 : 0; },
});

const say: ControllerAction = { op: 'runtime_say', target: RUNTIME_LINE_ERROR_ID, text: 'No microphone.' };
const unsay: ControllerAction = { op: 'runtime_unsay', target: RUNTIME_LINE_ERROR_ID };
const conversation: ControllerAction = {
  op: 'runtime_show', id: RUNTIME_CONVERSATION_ID, type: 'message', role: 'secondary',
  data: { context: 'X', tag: 'T', segments: [{ text: 'Hi.' }], channel: { name: 'VOICE' }, transcript: [] },
};
const room = () => (lastScene() as HTMLElement).style.getPropertyValue('--line-error-room');

describe('verify', () => {
  it('room set and removed on the idle page', () => {
    renderScene([]);
    runActions([say]);
    expect(room()).toBe('40px');
    runActions([unsay]);
    expect(lastScene().querySelector('.channel-stack__error')).toBe(null);
    expect(room()).toBe('');
  });
  it('room on the conversation page after a scene change, then removed', () => {
    renderScene([say]);
    expect(room()).toBe('40px');
    runActions([conversation]);
    expect(lastScene().getAttribute('data-scene')).toBe('conversation');
    expect(room()).toBe('40px');
    runActions([unsay]);
    expect(room()).toBe('');
  });
  it('epoch_reset and clear keep the error', () => {
    renderScene([say]);
    runActions([{ op: 'clear' } as ControllerAction, { op: 'epoch_reset' } as ControllerAction]);
    expect(lastScene().textContent).toContain('No microphone.');
  });
});
