// @vitest-environment jsdom
// A note's `anchor.item` names one item inside the object it targets (a
// calendar event, a task, a timer, a message, a forecast hour or day). While
// that note is the one drawn for the object (the rail's, or focus's), the
// page marks the item with the NOTE badge wherever the object is drawn --
// the main slot, an aux cell, focus -- and the card names it in the
// object's own words with the same badge; a name the object does not hold,
// or a note the page does not draw, marks nothing. Before this, nothing was marked and the card read
// "TARGET / todo" whatever the item.
//
// The convention every type keeps, whatever primitive draws it: each item
// element carries `data-item` (the name a note uses for it), and the marked
// one holds a `.note-badge`. Focus keeps the note beside the object.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { itemTargetText, markedItem } from '../../src/app/noteItems';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction, SceneObject, SceneObjectType } from '../../src/controller/types';

// For each type: an object holding two items, and the name a note uses for
// the second.
const lists = {
  calendar: {
    data: { view: 'day', start: '2026-10-07', events: [
      { id: 'standup', title: 'Standup', start: '2026-10-07T09:30' },
      { id: 'dentist', title: 'Dentist', start: '2026-10-07T10:30' },
    ] },
    item: 'dentist',
  },
  tasks: {
    data: { today: '2026-10-07', items: [
      { id: 'pr', text: 'Review the switchboard PR' },
      { id: 'passport', text: 'Renew passport', due: '2026-10-02' },
    ] },
    item: 'passport',
  },
  timer: {
    data: { timers: [
      { id: 'pasta', label: 'Pasta', endsAt: '2026-10-07T18:42:00-07:00' },
      { id: 'bread', label: 'Bread', endsAt: '2026-10-07T19:05:00-07:00' },
    ] },
    item: 'bread',
  },
  weather: {
    data: { location: 'San Francisco', units: 'F', current: { temp: 61, condition: 'fog' },
      hourly: [{ time: '2026-10-07T12:00', temp: 64, condition: 'fog' }],
      daily: [{ date: '2026-10-08', high: 61, low: 55, condition: 'rain' }] },
    item: '2026-10-08',
  },
  inbox: {
    data: { today: '2026-10-07', messages: [
      { id: 'ana', from: 'Ana', time: '2026-10-06T14:20' },
      { id: 'ci', from: 'GitHub', subject: 'CI failed', time: '2026-10-07T07:41' },
    ] },
    item: 'ci',
  },
} as const;
type ListType = keyof typeof lists;
const types = Object.keys(lists) as ListType[];

const object = (type: ListType, role?: 'primary' | 'secondary'): ControllerAction =>
  ({ op: 'show', id: 'list', type: type as SceneObjectType, ...(role ? { role } : {}), data: lists[type].data });
const noteOn = (item: string, target = 'list'): ControllerAction =>
  ({ op: 'show', id: 'item-note', type: 'note', data: { tag: 'NOTE', anchor: { target, item }, segments: [{ text: 'About this one.' }] } });
const table: ControllerAction = { op: 'show', id: 'grid', type: 'table', role: 'primary', data: { columns: [{ label: 'A' }], rows: [['1']] } };

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

const badges = (scope: Element | null, type: ListType) => [...(scope?.querySelectorAll(`[data-testid="${type}"] [data-item] .note-badge`) ?? [])];
const markedItems = (scope: Element | null, type: ListType) =>
  badges(scope, type).map((badge) => badge.closest('[data-item]')!.getAttribute('data-item'));
const scene = () => [...host!.querySelectorAll('[data-scene]')].at(-1)!;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

describe('markedItem', () => {
  it('is the item the drawn note names in the object', () => {
    expect(markedItem({ segments: [], anchor: { target: 'list', item: 'pr' } }, 'list')).toBe('pr');
  });

  it('is nothing for a note on another object, a note with no item, or no note', () => {
    expect(markedItem({ segments: [], anchor: { target: 'grid', item: 'pr' } }, 'list')).toBeUndefined();
    expect(markedItem({ segments: [], anchor: { target: 'list' } }, 'list')).toBeUndefined();
    expect(markedItem({ segments: [] }, 'list')).toBeUndefined();
    expect(markedItem(null, 'list')).toBeUndefined();
  });
});

describe('itemTargetText', () => {
  const sceneObject = (type: ListType): SceneObject => ({ id: 'list', type, data: lists[type].data, createdAt: 0, updatedAt: 0 });

  it.each(types)('a %s names an item it holds, and nothing for a name it does not', (type) => {
    expect(itemTargetText(sceneObject(type), lists[type].item)).toEqual(expect.any(String));
    expect(itemTargetText(sceneObject(type), 'no-such-item')).toBeUndefined();
  });

  it('a task is named by its text, a message by its sender and subject', () => {
    expect(itemTargetText(sceneObject('tasks'), 'passport')).toBe('Renew passport');
    expect(itemTargetText(sceneObject('inbox'), 'ci')).toBe('GitHub / CI failed');
    expect(itemTargetText(sceneObject('inbox'), 'ana')).toBe('Ana');
  });

  it('a type without items names nothing', () => {
    expect(itemTargetText({ id: 'grid', type: 'table', data: {}, createdAt: 0, updatedAt: 0 }, 'x')).toBeUndefined();
  });
});

describe('the item a note names is marked wherever its object is drawn', () => {
  it.each(types)('a %s primary marks the item, and the rail card names it with the badge', (type) => {
    render([object(type, 'primary'), noteOn(lists[type].item)]);
    expect(markedItems(scene(), type)).toEqual([lists[type].item]);
    const card = scene().querySelector('.content-rail .annotation-card');
    const named = itemTargetText({ id: 'list', type, data: lists[type].data, createdAt: 0, updatedAt: 0 }, lists[type].item);
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe(`TARGET / ${named}`);
    expect(card?.querySelectorAll('.annotation-card__header .note-badge')).toHaveLength(1);
  });

  it.each(types)('a %s in the aux row marks the item', (type) => {
    render([table, object(type, 'secondary'), noteOn(lists[type].item)]);
    expect(markedItems(scene().querySelector('.composed-aux'), type)).toEqual([lists[type].item]);
  });

  it.each(types)('a %s in focus marks the item and keeps the note, naming the item', (type) => {
    render([object(type, 'primary'), noteOn(lists[type].item)]);
    act(() => runActions([{ op: 'focus', id: 'list' }]));
    const layer = host!.querySelector('.focus-layer');
    expect(markedItems(layer, type)).toEqual([lists[type].item]);
    const named = itemTargetText({ id: 'list', type, data: lists[type].data, createdAt: 0, updatedAt: 0 }, lists[type].item);
    const card = layer?.querySelector('.focus-layer__note .annotation-card');
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe(`TARGET / ${named}`);
    expect(card?.querySelectorAll('.note-badge')).toHaveLength(1);
  });

  // A badge always has its card on screen: an item is marked only while the
  // note naming it is the one drawn for its object.
  it('marks nothing when the note the rail shows is another one about the list', () => {
    const plain: ControllerAction = { op: 'show', id: 'plain-note', type: 'note', data: { tag: 'PLAIN', anchor: { target: 'list' }, segments: [{ text: 'About the list.' }] } };
    render([object('tasks', 'primary'), plain, noteOn('passport')]);
    expect(badges(scene(), 'tasks')).toHaveLength(0);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(card?.querySelector('.annotation-card__tag')?.textContent).toBe('PLAIN');
    expect(card?.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('marks nothing in the aux row while the rail shows the primary\'s note', () => {
    const onGrid: ControllerAction = { op: 'show', id: 'grid-note', type: 'note', data: { tag: 'GRID', anchor: { target: 'grid' }, segments: [{ text: 'About the table.' }] } };
    render([table, object('inbox', 'secondary'), onGrid, noteOn('ci')]);
    expect(badges(scene().querySelector('.composed-aux'), 'inbox')).toHaveLength(0);
    expect(scene().querySelector('.content-rail .annotation-card__tag')?.textContent).toBe('GRID');
  });

  it('gives the card a line of its own for what it names, so the item is not cut beside the tag', () => {
    render([object('tasks', 'primary'), noteOn('passport')]);
    expect(scene().querySelector('.content-rail .annotation-card')?.classList.contains('annotation-card--item')).toBe(true);
  });

  it('gives a chart note naming an item no badge: a chart marks no items', () => {
    const chart: ControllerAction = { op: 'show', id: 'trend', type: 'chart', role: 'primary', data: { series: [{ name: 'S', values: [1, 2, 3] }] } };
    const stray: ControllerAction = { op: 'show', id: 'stray', type: 'note', data: { tag: 'STRAY', anchor: { target: 'trend', x: 1, item: 'x' }, segments: [{ text: 'On the chart.' }] } };
    const tasksBeside: ControllerAction = { op: 'show', id: 'list', type: 'tasks', role: 'secondary', data: lists.tasks.data };
    render([chart, tasksBeside, stray]);
    expect(scene().querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it.each(types)('a %s holding no item of the name marks nothing, and the card shows the anchor as sent with no badge', (type) => {
    render([object(type, 'primary'), noteOn('no-such-item')]);
    expect(badges(scene(), type)).toHaveLength(0);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe('TARGET / list / ITEM no-such-item');
    expect(card?.querySelectorAll('.note-badge')).toHaveLength(0);
  });
});
