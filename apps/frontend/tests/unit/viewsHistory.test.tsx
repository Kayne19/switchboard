// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { ControllerAction } from '../../src/controller/types';
import { RUNTIME_CONVERSATION_ID } from '../../src/controller/types';
import { lastScene, renderScene, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const table: ControllerAction = {
  op: 'show', id: 'news', type: 'table', role: 'primary',
  data: { title: 'WHAT IS NEW', columns: [{ label: 'CHANGE' }], rows: [['one']] },
};

const conversation: ControllerAction = {
  op: 'runtime_show', id: RUNTIME_CONVERSATION_ID, type: 'message', role: 'secondary',
  data: {
    context: 'OPERATOR LINE', tag: 'CURRENT RESPONSE / LIVE', caption: 'VOICE / 01',
    segments: [{ text: 'Here is what is new.' }],
    lines: [{ id: 0, text: 'Here is what is new.' }],
    channel: { name: 'VOICE' },
    transcript: [{ key: 0, speaker: 'DAMOCLES', text: 'Here is what is new.' }],
  },
};

const comms: ControllerAction = { op: 'set_view', view: 'comms' };
const theater: ControllerAction = { op: 'set_view', view: 'theater' };
const system: ControllerAction = { op: 'set_view', view: 'system' };

describe('the history stays reachable in every view', () => {
  it.each([
    ['a content scene', [table, conversation]],
    ['the comms view', [table, conversation, comms]],
    ['the theater view', [table, conversation, theater]],
    ['the system view', [table, conversation, system]],
  ])('%s', (_name, actions) => {
    renderScene(actions);
    const entry = lastScene().querySelector<HTMLButtonElement>('.transcript-toggle, [aria-label="Open conversation history"]');
    expect(entry, 'a control that opens the history').not.toBeNull();
    act(() => entry!.click());
    expect(document.querySelector('.transcript[role="dialog"]'), 'the history opens').not.toBeNull();
  });
});
