// @vitest-environment jsdom
// One rule for an object's title on its own meta line (primitives/MetaTitle.tsx):
// in the main slot the scene frame above shows the title, so the object
// does not repeat it; in an aux cell and in focus nothing else names the
// object, so its meta line leads with the title. Before the rule a table,
// a calendar, a to-do list and an inbox each showed their title twice in
// the main slot (Kayne's preview: "TO DO / THIS WEEK" over and inside the frame).
import { describe, expect, it } from 'vitest';
import type { ControllerAction, SceneObjectType } from '../../src/controller/types';
import { lastScene, renderScene, runActions, stubResizeObserver } from './sceneHarness';

const objects: Record<string, { title: string; data: Record<string, unknown> }> = {
  table: { title: 'TESTS / MATRIX', data: { title: 'TESTS / MATRIX', columns: [{ label: 'SUITE' }], rows: [['backend']] } },
  calendar: { title: 'WEEK / OCT 5-11', data: { title: 'WEEK / OCT 5-11', view: 'week', start: '2026-10-05', events: [{ id: 'standup', title: 'Standup', start: '2026-10-07T09:30' }] } },
  tasks: { title: 'TO DO / THIS WEEK', data: { title: 'TO DO / THIS WEEK', items: [{ id: 'pr', text: 'Review the PR' }] } },
  inbox: { title: 'INBOX / UNREAD FIRST', data: { title: 'INBOX / UNREAD FIRST', messages: [{ id: 'ci', from: 'GitHub', time: '2026-10-07T07:41' }] } },
};
const types = Object.keys(objects);

const show = (type: string, role: 'primary' | 'secondary'): ControllerAction =>
  ({ op: 'show', id: type, type: type as SceneObjectType, role, data: objects[type].data });
const code: ControllerAction = { op: 'show', id: 'source', type: 'code', role: 'primary', data: { title: 'SOURCE', source: { text: 'x' } } };
const ownTitles = (scope: Element | null, type: string) => [...(scope?.querySelectorAll(`[data-testid="${type}"] [data-object-title]`) ?? [])].map((node) => node.textContent);
/** Any text inside the object that is its title, marked or not. */
const titleTexts = (scope: Element | null, type: string) =>
  [...(scope?.querySelectorAll(`[data-testid="${type}"] *`) ?? [])].filter((node) => node.childElementCount === 0 && node.textContent === objects[type].title);

stubResizeObserver();

describe('an object names itself on its meta line only where nothing else does', () => {
  it.each(types)('the %s in the main slot leaves its title to the scene frame', (type) => {
    renderScene([show(type, 'primary')]);
    const scene = lastScene();
    expect(scene.querySelector('.scene-heading__title')?.textContent).toBe(objects[type].title);
    expect(titleTexts(scene, type)).toEqual([]);
  });

  it.each(types)('the %s in the aux row names itself', (type) => {
    const page = renderScene([code, show(type, 'secondary')]);
    expect(ownTitles(page.querySelector('.composed-aux'), type)).toEqual([objects[type].title]);
  });

  it.each(types)('the %s in focus names itself', (type) => {
    const page = renderScene([show(type, 'primary')]);
    runActions([{ op: 'focus', id: type }]);
    expect(ownTitles(page.querySelector('.focus-layer'), type)).toEqual([objects[type].title]);
  });
});

// Counts are said once, by the object's meta line (or a list's section
// heads): the scene frame's subtitle and caption, where the agent sent
// none, name what the object is, never how much it holds. Before, an inbox
// said '50 MESSAGES' in its subtitle, its meta line and its caption.
describe('the scene frame never repeats what the object counts', () => {
  const counted = /\d+ (ROWS?|COLUMNS?|COLS|EVENTS?|OPEN|DONE|OVERDUE|ITEMS?|MESSAGES?|UNREAD|FLAGGED)\b/;
  it.each(types)('the %s in the main slot', (type) => {
    renderScene([show(type, 'primary')]);
    const scene = lastScene();
    const frame = [scene.querySelector('.scene-heading__sub')?.textContent, ...[...scene.querySelectorAll('.scene-footer span')].map((span) => span.textContent)];
    expect(frame.filter((text) => counted.test(text ?? ''))).toEqual([]);
  });
});
