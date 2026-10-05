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
import { itemTargetText, markedItem, noteTarget, objectName } from '../../src/app/noteItems';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction, NoteData, SceneObject, SceneObjectType } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

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

  it('keeps what the card names and its badge together, so a line of its own takes both', () => {
    render([object('tasks', 'primary'), noteOn('passport')]);
    const target = scene().querySelector('.content-rail .annotation-card__target');
    expect([...(target?.children ?? [])].map((child) => child.className)).toEqual(['annotation-card__anchor tech micro', 'note-badge tech micro']);
  });

  it('gives a chart note naming an item no badge: a chart marks no items', () => {
    const chart: ControllerAction = { op: 'show', id: 'trend', type: 'chart', role: 'primary', data: { series: [{ name: 'S', values: [1, 2, 3] }] } };
    const stray: ControllerAction = { op: 'show', id: 'stray', type: 'note', data: { tag: 'STRAY', anchor: { target: 'trend', x: 1, item: 'x' }, segments: [{ text: 'On the chart.' }] } };
    const tasksBeside: ControllerAction = { op: 'show', id: 'list', type: 'tasks', role: 'secondary', data: lists.tasks.data };
    render([chart, tasksBeside, stray]);
    expect(scene().querySelectorAll('.note-badge')).toHaveLength(0);
  });

  // The card showed the anchor as sent, "TARGET / list / ITEM no-such-item":
  // an object id and an item id a caller never reads.
  it.each(types)('a %s holding no item of the name marks nothing, and the card names the list, with no badge', (type) => {
    render([object(type, 'primary'), noteOn('no-such-item')]);
    expect(badges(scene(), type)).toHaveLength(0);
    const card = scene().querySelector('.content-rail .annotation-card');
    const named = type === 'weather' ? 'San Francisco' : type.toUpperCase();
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe(`TARGET / ${named}`);
    expect(card?.querySelectorAll('.note-badge')).toHaveLength(0);
  });
});

// A card's TARGET line named a note's object by its id wherever the object
// was not a chart or a list naming one of its items: "TARGET / test-matrix"
// for a table, "TARGET / system-map / NODE session" for a node, in the rail
// and in focus. A caller never reads an id: the line names the object in
// its own words, or the part of it the anchor names.
describe('noteTarget names what a note is about in its object\'s words, never an id', () => {
  const stage = (type: SceneObjectType, data: unknown, id = 'obj'): Record<string, SceneObject> => ({ [id]: { id, type, data, createdAt: 0, updatedAt: 0 } });
  const about = (anchor: Omit<NonNullable<NoteData['anchor']>, 'target'>, target = 'obj'): NoteData => ({ segments: [{ text: 'About it.' }], anchor: { target, ...anchor } });
  const named = (type: SceneObjectType, data: unknown, anchor: Omit<NonNullable<NoteData['anchor']>, 'target'> = {}) => noteTarget(stage(type, data), about(anchor));

  const graph = { mode: 'graph', title: 'CI / PIPELINE', nodes: [{ id: 'gate', label: 'Display gate' }, { id: 'page', label: 'Page' }], edges: [{ from: 'gate', to: 'page' }] };
  const sequence = { mode: 'sequence', title: 'CALL / HANDOFF', actors: [{ id: 'caller', label: 'CALLER' }, { id: 'pbx', label: 'PBX' }], messages: [] };
  const chart = { title: 'CI / DURATIONS', labels: ['backend', 'frontend'], series: [{ name: 'THIS RUN', values: [1, 2] }] };
  const image = { format: 'png', bytes: 'iVBORw0KGgo=', alt: 'Test card: seven palette bars', title: 'FIGURE / TEST CARD' };

  // Each type, titled and not: the field that names it, and the type's name where it carries none.
  const objects: Array<{ type: SceneObjectType; data: Record<string, unknown>; name: string; untitled: Record<string, unknown>; fallback: string }> = [
    { type: 'chart', data: chart, name: 'CI / DURATIONS', untitled: { ...chart, title: undefined }, fallback: 'CHART' },
    { type: 'diagram', data: graph, name: 'CI / PIPELINE', untitled: { ...graph, title: undefined }, fallback: 'DIAGRAM' },
    { type: 'table', data: { title: 'TESTS / MATRIX', columns: [{ label: 'A' }], rows: [['1']] }, name: 'TESTS / MATRIX', untitled: { columns: [{ label: 'A' }], rows: [['1']] }, fallback: 'TABLE' },
    { type: 'code', data: { title: 'SOURCE / ROUTER', file: 'router.ts', source: { text: 'x' } }, name: 'SOURCE / ROUTER', untitled: { file: 'router.ts', source: { text: 'x' } }, fallback: 'CODE' },
    { type: 'document', data: { subject: 'Re: revised results', paragraphs: ['Hi'] }, name: 'Re: revised results', untitled: { subject: ' ', paragraphs: ['Hi'] }, fallback: 'DOCUMENT' },
    { type: 'image', data: image, name: 'FIGURE / TEST CARD', untitled: { ...image, title: undefined }, fallback: 'Test card: seven palette bars' },
    { type: 'metric', data: { label: 'TESTS PASSED', value: '870' }, name: 'TESTS PASSED', untitled: { label: '', value: '870' }, fallback: 'METRIC' },
    { type: 'progress', data: { label: 'VISUAL-PALETTE', value: 57 }, name: 'VISUAL-PALETTE', untitled: { label: ' ', value: 57 }, fallback: 'PROGRESS' },
    { type: 'note', data: { tag: 'DAMOCLES / PLAN', segments: [] }, name: 'NOTE', untitled: { segments: [] }, fallback: 'NOTE' },
    ...types.map((type) => ({
      type: type as SceneObjectType,
      data: { ...lists[type].data, title: `MY ${type.toUpperCase()}` },
      name: `MY ${type.toUpperCase()}`,
      untitled: lists[type].data,
      // A forecast is named by its place, as the agent's view names it.
      fallback: type === 'weather' ? 'San Francisco' : type.toUpperCase(),
    })),
  ];

  it.each(objects)('names a $type by its title, and by its type\'s name where it has none', ({ type, data, name, untitled, fallback }) => {
    expect(named(type, data)).toEqual({ target: name, marked: false });
    expect(objectName({ id: 'obj', type, data, createdAt: 0, updatedAt: 0 })).toBe(name);
    expect(named(type, untitled)).toEqual({ target: fallback, marked: false });
  });

  it('names the part an anchor names in its object\'s words, and marks a node, an actor or an item', () => {
    // A chart's point: its category and series; the chart rings or outlines it, with no badge.
    expect(named('chart', chart, { x: 1 })).toEqual({ target: 'frontend', marked: false });
    expect(named('chart', chart, { series: 'THIS RUN' })).toEqual({ target: 'THIS RUN', marked: false });
    // A diagram's node and a sequence's actor: their labels, marked with the NOTE marker.
    expect(named('diagram', graph, { node: 'gate' })).toEqual({ target: 'Display gate', marked: true });
    expect(named('diagram', sequence, { node: 'pbx' })).toEqual({ target: 'PBX', marked: true });
    // A list's item.
    for (const type of types) {
      const item = itemTargetText({ id: 'obj', type, data: lists[type].data, createdAt: 0, updatedAt: 0 }, lists[type].item);
      expect(named(type, lists[type].data, { item: lists[type].item })).toEqual({ target: item, marked: true });
    }
    expect(named('calendar', lists.calendar.data, { item: 'dentist' }).target).toBe('Dentist / WED OCT 7 10:30');
    expect(named('weather', lists.weather.data, { item: '2026-10-08' }).target).toBe('THU OCT 8');
  });

  it('names the object, unmarked, where the part its anchor names is not there or the type has no such parts', () => {
    expect(named('chart', chart, { series: 'NOPE' })).toEqual({ target: 'CI / DURATIONS', marked: false });
    expect(named('chart', { ...chart, title: ' ' }, { series: 'NOPE' })).toEqual({ target: 'CHART', marked: false });
    expect(named('diagram', graph, { node: 'gone' })).toEqual({ target: 'CI / PIPELINE', marked: false });
    expect(named('diagram', sequence, { node: 'gone' })).toEqual({ target: 'CALL / HANDOFF', marked: false });
    expect(named('tasks', lists.tasks.data, { item: 'gone' })).toEqual({ target: 'TASKS', marked: false });
    // A node on a list, an item on a diagram or a table: parts those types do not have.
    expect(named('tasks', lists.tasks.data, { node: 'passport' })).toEqual({ target: 'TASKS', marked: false });
    expect(named('diagram', graph, { item: 'gate' })).toEqual({ target: 'CI / PIPELINE', marked: false });
    expect(named('table', { title: 'GRID', columns: [], rows: [] }, { item: 'x' })).toEqual({ target: 'GRID', marked: false });
  });

  it('names nothing for a note with no anchor, or about an object not on stage', () => {
    expect(noteTarget(stage('table', { title: 'GRID' }), { segments: [] })).toEqual({ marked: false });
    expect(noteTarget(stage('table', { title: 'GRID' }), about({}, 'elsewhere'))).toEqual({ marked: false });
    expect(noteTarget({}, null)).toEqual({ marked: false });
  });
});

describe('every card names its object in its own words', () => {
  const anchorText = (card: Element | null | undefined) => card?.querySelector('.annotation-card__anchor')?.textContent;
  const results = fixtures.results;
  const noteAbout = (target: string, extra: Partial<NonNullable<NoteData['anchor']>> = {}): ControllerAction =>
    ({ op: 'show', id: 'results-note', type: 'note', data: { tag: 'DAMOCLES / FAILURES', anchor: { target, ...extra }, segments: [{ text: 'Two failures.' }] } });

  it('in the rail and in focus: a table by its title', () => {
    render([...results, noteAbout('test-matrix')]);
    expect(anchorText(scene().querySelector('.content-rail .annotation-card'))).toBe('TARGET / TESTS / MATRIX');
    act(() => runActions([{ op: 'focus', id: 'test-matrix' }]));
    expect(anchorText(host!.querySelector('.focus-layer__note .annotation-card'))).toBe('TARGET / TESTS / MATRIX');
  });

  it('a metric and a progress by their labels', () => {
    render([...results, { op: 'show', id: 'passed', type: 'metric', data: { label: 'TESTS PASSED', value: '870' } }, noteAbout('passed')]);
    expect(anchorText(scene().querySelector('.content-rail .annotation-card'))).toBe('TARGET / TESTS PASSED');
    act(() => runActions([{ op: 'focus', id: 'passed' }]));
    expect(anchorText(host!.querySelector('.focus-layer__note .annotation-card'))).toBe('TARGET / TESTS PASSED');
    act(() => runActions([{ op: 'clear' }, ...fixtures.plan]));
    expect(anchorText(scene().querySelector('.content-rail .annotation-card'))).toBe('TARGET / VISUAL-PALETTE');
  });

  it('a node by its label, with the badge that matches its marker; a node the diagram does not hold by the diagram, with none', () => {
    render([...fixtures.topology]);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(anchorText(card)).toBe('TARGET / Display gate');
    expect(card?.querySelectorAll('.annotation-card__header .note-badge')).toHaveLength(1);
    act(() => runActions([{ op: 'show', id: 'topology-note', type: 'note', data: { tag: 'GONE', anchor: { target: 'topology', node: 'gone' }, segments: [{ text: 'Its node is gone.' }] } }]));
    const after = scene().querySelector('.content-rail .annotation-card');
    expect(anchorText(after)).toBe('TARGET / SYSTEM / SWITCHBOARD TOPOLOGY');
    expect(after?.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('a focused note, and a note drawn as the primary, name their object too, with no badge', () => {
    render([...fixtures.plan]);
    act(() => runActions([{ op: 'focus', id: 'plan-note' }]));
    const focused = host!.querySelector('.focus-layer .annotation-card');
    expect(anchorText(focused)).toBe('TARGET / VISUAL-PALETTE');
    act(() => runActions([
      { op: 'clear' },
      { op: 'show', id: 'latency', type: 'metric', data: { label: 'P95 LATENCY', value: '182 ms' } },
      { op: 'show', id: 'latency-note', type: 'note', role: 'primary', data: { tag: 'DAMOCLES / LATENCY', anchor: { target: 'latency' }, segments: [{ text: 'Back under two hundred.' }] } },
    ]));
    const primary = scene().querySelector('.composed-primary-object .annotation-card');
    expect(anchorText(primary)).toBe('TARGET / P95 LATENCY');
    expect(primary?.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('a note about no object on stage has no TARGET line at all', () => {
    render([...results, noteAbout('gone')]);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(card?.querySelector('.annotation-card__tag')?.textContent).toBe('DAMOCLES / FAILURES');
    expect(card?.querySelector('.annotation-card__anchor')).toBeNull();
  });
});

// A note about a node of a diagram in the aux row carried the badge on its
// rail card while the cell drew the node unmarked: the cell drew the
// diagram with no note. A badge has its mark on screen, as a list's item
// has in its cell.
describe('a diagram beside the primary marks the node the rail note names', () => {
  const flow: ControllerAction = { op: 'show', id: 'flow', type: 'diagram', role: 'secondary', data: {
    mode: 'graph', title: 'CALL / FLOW', nodes: [{ id: 'gate', label: 'Display gate' }, { id: 'page', label: 'Page' }], edges: [{ from: 'gate', to: 'page' }],
  } };
  const onGate: ControllerAction = { op: 'show', id: 'gate-note', type: 'note', data: { tag: 'GATE', anchor: { target: 'flow', node: 'gate' }, segments: [{ text: 'The gate stamps each action.' }] } };

  it('marks the node in its cell while the rail shows that note, and no node while it shows another', () => {
    render([table, flow, onGate]);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe('TARGET / Display gate');
    expect(card?.querySelectorAll('.annotation-card__header .note-badge')).toHaveLength(1);
    const cell = scene().querySelector('.composed-aux');
    expect(cell?.querySelectorAll('.diagram-node__body--anchored')).toHaveLength(1);
    expect(cell?.querySelector('.diagram-node__body--anchored')?.textContent).toContain('Display gate');
    const onGrid: ControllerAction = { op: 'show', id: 'grid-note', type: 'note', data: { tag: 'GRID', anchor: { target: 'grid' }, segments: [{ text: 'About the table.' }] } };
    act(() => runActions([onGrid]));
    expect(scene().querySelector('.content-rail .annotation-card__tag')?.textContent).toBe('GRID');
    expect(scene().querySelectorAll('.composed-aux .diagram-node__body--anchored')).toHaveLength(0);
  });
});
