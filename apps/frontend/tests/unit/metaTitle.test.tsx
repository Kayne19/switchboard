// @vitest-environment jsdom
// One rule for an object's title on its own meta line (primitives/MetaTitle.tsx):
// in the main slot the scene frame above shows the title, so the object
// does not repeat it; in an aux cell and in focus nothing else names the
// object, so its meta line leads with the title. Before the rule a table,
// a calendar, a to-do list and an inbox each showed their title twice in
// the main slot (Kayne's preview: "TO DO / THIS WEEK" over and inside the frame).
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction, SceneObjectType } from '../../src/controller/types';

const objects: Record<string, { title: string; data: Record<string, unknown> }> = {
  table: { title: 'TESTS / MATRIX', data: { title: 'TESTS / MATRIX', columns: [{ label: 'SUITE' }], rows: [['backend']] } },
  calendar: { title: 'WEEK / OCT 5-11', data: { title: 'WEEK / OCT 5-11', view: 'week', start: '2026-10-05', events: [{ id: 'standup', title: 'Standup', start: '2026-10-07T09:30' }] } },
  tasks: { title: 'TO DO / THIS WEEK', data: { title: 'TO DO / THIS WEEK', items: [{ id: 'pr', text: 'Review the PR' }] } },
  inbox: { title: 'INBOX / UNREAD FIRST', data: { title: 'INBOX / UNREAD FIRST', messages: [{ id: 'ci', from: 'GitHub', time: '2026-10-07T07:41' }] } },
};
const types = Object.keys(objects);

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let runActions: (actions: ControllerAction[]) => void = () => {};

function Scene({ actions }: { actions: ControllerAction[] }) {
  const { run } = useController();
  runActions = (more) => run(more);
  useEffect(() => run(actions), [actions, run]);
  return null;
}

function render(actions: ControllerAction[]): HTMLElement {
  const page = document.createElement('div');
  document.body.append(page);
  const pageRoot = createRoot(page);
  host = page;
  root = pageRoot;
  act(() => pageRoot.render(
    <ControllerProvider>
      <Scene actions={actions} />
      <SceneRenderer />
    </ControllerProvider>,
  ));
  return page;
}

const show = (type: string, role: 'primary' | 'secondary'): ControllerAction =>
  ({ op: 'show', id: type, type: type as SceneObjectType, role, data: objects[type].data });
const code: ControllerAction = { op: 'show', id: 'source', type: 'code', role: 'primary', data: { title: 'SOURCE', source: { text: 'x' } } };
const ownTitles = (scope: Element | null, type: string) => [...(scope?.querySelectorAll(`[data-testid="${type}"] [data-object-title]`) ?? [])].map((node) => node.textContent);
/** Any text inside the object that is its title, marked or not. */
const titleTexts = (scope: Element | null, type: string) =>
  [...(scope?.querySelectorAll(`[data-testid="${type}"] *`) ?? [])].filter((node) => node.childElementCount === 0 && node.textContent === objects[type].title);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  const rendered = root;
  if (rendered) act(() => rendered.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('an object names itself on its meta line only where nothing else does', () => {
  it.each(types)('the %s in the main slot leaves its title to the scene frame', (type) => {
    const page = render([show(type, 'primary')]);
    const scene = [...page.querySelectorAll('[data-scene]')].at(-1)!;
    expect(scene.querySelector('.scene-heading__title')?.textContent).toBe(objects[type].title);
    expect(titleTexts(scene, type)).toEqual([]);
  });

  it.each(types)('the %s in the aux row names itself', (type) => {
    const page = render([code, show(type, 'secondary')]);
    expect(ownTitles(page.querySelector('.composed-aux'), type)).toEqual([objects[type].title]);
  });

  it.each(types)('the %s in focus names itself', (type) => {
    render([show(type, 'primary')]);
    act(() => runActions([{ op: 'focus', id: type }]));
    expect(ownTitles(host!.querySelector('.focus-layer'), type)).toEqual([objects[type].title]);
  });
});
