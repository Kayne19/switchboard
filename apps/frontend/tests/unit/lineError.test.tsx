// @vitest-environment jsdom
// A line error -- the microphone refused, the line lost, a server error --
// reaches the page as `runtime_say` to RUNTIME_LINE_ERROR_ID (runtime.tsx),
// and an error with nowhere to go is a browser that fails silently
// (ARCHITECTURE.md). Only a content scene's rail drew it, in its note slot,
// where a note or Damocles's own words took its place, and the next line
// Damocles was heard saying took it down; the theater view (#514) keeps
// Damocles so push-to-talk works there, and has no rail.
import { describe, expect, it } from 'vitest';
import type { ControllerAction } from '../../src/controller/types';
import { RUNTIME_CONVERSATION_ID, RUNTIME_LINE_ERROR_ID } from '../../src/controller/types';
import { lastScene, renderScene, runActions, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const ERROR_TEXT = 'Microphone unavailable (NotAllowedError).';

const table: ControllerAction = {
  op: 'show', id: 'news', type: 'table', role: 'primary',
  data: { title: 'WHAT IS NEW', columns: [{ label: 'CHANGE' }], rows: [['one']] },
};

const note: ControllerAction = {
  op: 'show', id: 'why', type: 'note',
  data: { tag: 'NOTE', segments: [{ text: 'One change.' }], anchor: { target: 'news' } },
};

// The call's conversation, as runtime.tsx keeps it once anything was said.
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

const said: ControllerAction = { op: 'say', text: 'Look at the first row.' };

// The next line Damocles is heard saying, as runtime.tsx puts it on screen.
const heard: ControllerAction = { op: 'runtime_say', target: RUNTIME_CONVERSATION_ID, text: 'And one more change.' };

const lineError: ControllerAction = { op: 'runtime_say', target: RUNTIME_LINE_ERROR_ID, text: ERROR_TEXT };

describe('a line error is drawn wherever the caller can tap Damocles', () => {
  it.each([
    ['a content scene', [table, conversation], []],
    ['a content scene whose rail carries a note', [table, conversation, note], []],
    ['a content scene Damocles says something about after it', [table, conversation], [said]],
    ['the theater view', [table, conversation, { op: 'set_view', view: 'theater' } as ControllerAction], []],
    ['the conversation page', [conversation], []],
    ['the conversation page, once Damocles is heard again', [conversation], [heard]],
    ['the idle page', [], []],
  ])('%s', (_name, before, after) => {
    renderScene(before);
    runActions([lineError, ...after]);
    const drawn = lastScene().textContent ?? '';
    expect(drawn, 'the error the caller must read').toContain(ERROR_TEXT);
    expect(drawn.split(ERROR_TEXT).length - 1, 'drawn once').toBe(1);
  });

  it('leaves it to the system view, whose STATUS row says it', () => {
    renderScene([table, conversation, { op: 'set_view', view: 'system' }]);
    runActions([lineError]);
    expect(lastScene().getAttribute('data-scene')).toBe('system');
    expect(lastScene().querySelector('.channel-stack__error'), 'not over the corner stack').toBe(null);
  });
});
