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
import { describe, expect, it } from 'vitest';
import { itemTargetText, markedItem, markingNote, noteTarget, objectName, railNoteTarget } from '../../src/app/noteItems';
import type { ControllerAction, NoteData, SceneObject, SceneObjectType } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { chartSeriesPoint } from '../../src/primitives/chartGeometry';
import { lastScene, renderScene, runActions, stubResizeObserver } from './sceneHarness';

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

const badges = (scope: Element | null, type: ListType) => [...(scope?.querySelectorAll(`[data-testid="${type}"] [data-item] .note-badge`) ?? [])];
const markedItems = (scope: Element | null, type: ListType) =>
  badges(scope, type).map((badge) => badge.closest('[data-item]')!.getAttribute('data-item'));
const scene = lastScene;

stubResizeObserver();

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

// An object marks one part: of the notes the page draws, the first about it
// (review-fix-charts M4).
describe('markingNote and railNoteTarget', () => {
  const list: SceneObject = { id: 'list', type: 'tasks', data: lists.tasks.data, createdAt: 0, updatedAt: 0 };
  const on = (item: string): NoteData => ({ segments: [], anchor: { target: 'list', item } });
  const general: NoteData = { segments: [] };
  const first = on('passport');
  const second = on('pr');

  it('picks the first note about the object, past notes about none', () => {
    expect(markingNote([general, first, second], 'list')).toBe(first);
    expect(markingNote([general], 'list')).toBeUndefined();
  });

  it('keeps the badge on the marking note only, and names both', () => {
    const drawn = [first, second];
    expect(railNoteTarget({ list }, drawn, first)).toEqual(noteTarget({ list }, first));
    expect(railNoteTarget({ list }, drawn, first).marked).toBe(true);
    expect(railNoteTarget({ list }, drawn, second)).toEqual({ target: noteTarget({ list }, second).target, marked: false });
  });
});

describe('the item a note names is marked wherever its object is drawn', () => {
  it.each(types)('a %s primary marks the item, and the rail card names it with the badge', (type) => {
    renderScene([object(type, 'primary'), noteOn(lists[type].item)]);
    expect(markedItems(scene(), type)).toEqual([lists[type].item]);
    const card = scene().querySelector('.content-rail .annotation-card');
    const named = itemTargetText({ id: 'list', type, data: lists[type].data, createdAt: 0, updatedAt: 0 }, lists[type].item);
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe(`TARGET / ${named}`);
    expect(card?.querySelectorAll('.annotation-card__header .note-badge')).toHaveLength(1);
  });

  it.each(types)('a %s in the aux row marks the item', (type) => {
    renderScene([table, object(type, 'secondary'), noteOn(lists[type].item)]);
    expect(markedItems(scene().querySelector('.composed-aux'), type)).toEqual([lists[type].item]);
  });

  it.each(types)('a %s in focus marks the item and keeps the note, naming the item', (type) => {
    const page = renderScene([object(type, 'primary'), noteOn(lists[type].item)]);
    runActions([{ op: 'focus', id: 'list' }]);
    const layer = page.querySelector('.focus-layer');
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
    renderScene([object('tasks', 'primary'), plain, noteOn('passport')]);
    expect(badges(scene(), 'tasks')).toHaveLength(0);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(card?.querySelector('.annotation-card__tag')?.textContent).toBe('PLAIN');
    expect(card?.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  // The rail showed one note, so the aux row's item went unmarked and its
  // note unseen (pr/issues.md, "The rail shows one note"). It shows every
  // note now, the primary's first, and the item is marked beside its card.
  it('marks the item in the aux row while the rail shows its note after the primary\'s', () => {
    const onGrid: ControllerAction = { op: 'show', id: 'grid-note', type: 'note', data: { tag: 'GRID', anchor: { target: 'grid' }, segments: [{ text: 'About the table.' }] } };
    renderScene([table, object('inbox', 'secondary'), onGrid, noteOn('ci')]);
    expect(badges(scene().querySelector('.composed-aux'), 'inbox')).toHaveLength(1);
    const cards = [...scene().querySelectorAll('.content-rail .annotation-card')];
    expect(cards.map((card) => card.querySelector('.annotation-card__tag')?.textContent)).toEqual(['GRID', 'NOTE']);
    expect(cards.map((card) => card.querySelectorAll('.annotation-card__header .note-badge').length)).toEqual([0, 1]);
  });

  // An object marks one part: a second note about another item of the same
  // list is shown, named, but carries no badge, so a badge always has its mark.
  it('marks the first of two items notes name in one list, and badges only its card', () => {
    const second: ControllerAction = { op: 'show', id: 'second-note', type: 'note', data: { tag: 'SECOND', anchor: { target: 'list', item: 'pr' }, segments: [{ text: 'And this one.' }] } };
    renderScene([object('tasks', 'primary'), noteOn(lists.tasks.item), second]);
    expect(markedItems(scene(), 'tasks')).toEqual([lists.tasks.item]);
    const cards = [...scene().querySelectorAll('.content-rail .annotation-card')];
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.querySelectorAll('.annotation-card__header .note-badge').length)).toEqual([1, 0]);
  });

  it('keeps what the card names and its badge together, so a line of its own takes both', () => {
    renderScene([object('tasks', 'primary'), noteOn('passport')]);
    const target = scene().querySelector('.content-rail .annotation-card__target');
    expect([...(target?.children ?? [])].map((child) => child.className)).toEqual(['annotation-card__anchor tech micro', 'note-badge tech micro']);
  });

  it('gives a chart note naming an item no badge: a chart marks no items', () => {
    const chart: ControllerAction = { op: 'show', id: 'trend', type: 'chart', role: 'primary', data: { series: [{ name: 'S', values: [1, 2, 3] }] } };
    const stray: ControllerAction = { op: 'show', id: 'stray', type: 'note', data: { tag: 'STRAY', anchor: { target: 'trend', x: 1, item: 'x' }, segments: [{ text: 'On the chart.' }] } };
    const tasksBeside: ControllerAction = { op: 'show', id: 'list', type: 'tasks', role: 'secondary', data: lists.tasks.data };
    renderScene([chart, tasksBeside, stray]);
    expect(scene().querySelectorAll('.note-badge')).toHaveLength(0);
  });

  // The card showed the anchor as sent, "TARGET / list / ITEM no-such-item":
  // an object id and an item id a caller never reads.
  it.each(types)('a %s holding no item of the name marks nothing, and the card names the list, with no badge', (type) => {
    renderScene([object(type, 'primary'), noteOn('no-such-item')]);
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
    // Untitled code is named by its file, as its frame shows it; with neither, by its type.
    { type: 'code', data: { title: 'SOURCE / ROUTER', file: 'router.ts', source: { text: 'x' } }, name: 'SOURCE / ROUTER', untitled: { file: 'router.ts', source: { text: 'x' } }, fallback: 'router.ts' },
    { type: 'code', data: { title: 'SOURCE / ROUTER', source: { text: 'x' } }, name: 'SOURCE / ROUTER', untitled: { source: { text: 'x' } }, fallback: 'CODE' },
    { type: 'document', data: { subject: 'Re: revised results', paragraphs: ['Hi'] }, name: 'Re: revised results', untitled: { subject: ' ', paragraphs: ['Hi'] }, fallback: 'DOCUMENT' },
    { type: 'image', data: image, name: 'FIGURE / TEST CARD', untitled: { ...image, title: undefined }, fallback: 'Test card: seven palette bars' },
    { type: 'metric', data: { label: 'TESTS PASSED', value: '870' }, name: 'TESTS PASSED', untitled: { label: '', value: '870' }, fallback: 'METRIC' },
    { type: 'progress', data: { label: 'VISUAL-PALETTE', value: 57 }, name: 'VISUAL-PALETTE', untitled: { label: ' ', value: 57 }, fallback: 'PROGRESS' },
    // A note about a note: the other's tag, as it shows it.
    { type: 'note', data: { tag: 'DAMOCLES / PLAN', segments: [] }, name: 'DAMOCLES / PLAN', untitled: { segments: [] }, fallback: 'NOTE' },
    // An untitled sequence by its kind, as its frame names it.
    { type: 'diagram', data: sequence, name: 'CALL / HANDOFF', untitled: { ...sequence, title: undefined }, fallback: 'SEQUENCE' },
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
    const page = renderScene([...results, noteAbout('test-matrix')]);
    expect(anchorText(scene().querySelector('.content-rail .annotation-card'))).toBe('TARGET / TESTS / MATRIX');
    runActions([{ op: 'focus', id: 'test-matrix' }]);
    expect(anchorText(page.querySelector('.focus-layer__note .annotation-card'))).toBe('TARGET / TESTS / MATRIX');
  });

  it('a metric and a progress by their labels', () => {
    const page = renderScene([...results, { op: 'show', id: 'passed', type: 'metric', data: { label: 'TESTS PASSED', value: '870' } }, noteAbout('passed')]);
    expect(anchorText(scene().querySelector('.content-rail .annotation-card'))).toBe('TARGET / TESTS PASSED');
    runActions([{ op: 'focus', id: 'passed' }]);
    expect(anchorText(page.querySelector('.focus-layer__note .annotation-card'))).toBe('TARGET / TESTS PASSED');
    runActions([{ op: 'clear' }, ...fixtures.plan]);
    expect(anchorText(scene().querySelector('.content-rail .annotation-card'))).toBe('TARGET / VISUAL-PALETTE');
  });

  it('a node by its label, with the badge that matches its marker; a node the diagram does not hold by the diagram, with none', () => {
    renderScene([...fixtures.topology]);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(anchorText(card)).toBe('TARGET / Display gate');
    expect(card?.querySelectorAll('.annotation-card__header .note-badge')).toHaveLength(1);
    runActions([{ op: 'show', id: 'topology-note', type: 'note', data: { tag: 'GONE', anchor: { target: 'topology', node: 'gone' }, segments: [{ text: 'Its node is gone.' }] } }]);
    const after = scene().querySelector('.content-rail .annotation-card');
    expect(anchorText(after)).toBe('TARGET / SYSTEM / SWITCHBOARD TOPOLOGY');
    expect(after?.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('a focused note, and a note drawn as the primary, name their object too, with no badge', () => {
    const page = renderScene([...fixtures.plan]);
    runActions([{ op: 'focus', id: 'plan-note' }]);
    const focused = page.querySelector('.focus-layer .annotation-card');
    expect(anchorText(focused)).toBe('TARGET / VISUAL-PALETTE');
    runActions([
      { op: 'clear' },
      { op: 'show', id: 'latency', type: 'metric', data: { label: 'P95 LATENCY', value: '182 ms' } },
      { op: 'show', id: 'latency-note', type: 'note', role: 'primary', data: { tag: 'DAMOCLES / LATENCY', anchor: { target: 'latency' }, segments: [{ text: 'Back under two hundred.' }] } },
    ]);
    const primary = scene().querySelector('.composed-primary-object .annotation-card');
    expect(anchorText(primary)).toBe('TARGET / P95 LATENCY');
    expect(primary?.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('a note about no object on stage has no TARGET line at all', () => {
    renderScene([...results, noteAbout('gone')]);
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

  it('marks the node in its cell while the rail shows that note, after the primary\'s', () => {
    renderScene([table, flow, onGate]);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe('TARGET / Display gate');
    expect(card?.querySelectorAll('.annotation-card__header .note-badge')).toHaveLength(1);
    const cell = scene().querySelector('.composed-aux');
    expect(cell?.querySelectorAll('.diagram-node__body--anchored')).toHaveLength(1);
    expect(cell?.querySelector('.diagram-node__body--anchored')?.textContent).toContain('Display gate');
    const onGrid: ControllerAction = { op: 'show', id: 'grid-note', type: 'note', data: { tag: 'GRID', anchor: { target: 'grid' }, segments: [{ text: 'About the table.' }] } };
    runActions([onGrid]);
    const tags = [...scene().querySelectorAll('.content-rail .annotation-card__tag')].map((tag) => tag.textContent);
    expect(tags).toEqual(['GRID', 'GATE']);
    expect(scene().querySelectorAll('.composed-aux .diagram-node__body--anchored')).toHaveLength(1);
  });
});

// A note about a calendar event the view does not reach (a day view of
// Wednesday, an event on the 20th) named the event with the NOTE badge
// while the calendar, which draws only its days, marked nothing: a badge
// with no mark on screen (last-gaps review M1).
describe('an event the calendar does not draw', () => {
  const later = {
    ...lists.calendar.data,
    events: [...lists.calendar.data.events, { id: 'later', title: 'Later', start: '2026-10-20T10:30' }],
  };
  const calendar = (data: unknown): ControllerAction => ({ op: 'show', id: 'list', type: 'calendar', role: 'primary', data } as ControllerAction);

  it.each([
    ['a day', later],
    ['an agenda of two days', { ...later, view: 'agenda', days: 2 }],
  ])('in %s is named on the card, with no badge, as the calendar marks nothing', (_view, data) => {
    renderScene([calendar(data), noteOn('later')]);
    expect(badges(scene(), 'calendar')).toHaveLength(0);
    const card = scene().querySelector('.content-rail .annotation-card');
    expect(card?.querySelector('.annotation-card__anchor')?.textContent).toBe('TARGET / Later / TUE OCT 20 10:30');
    expect(card?.querySelectorAll('.note-badge')).toHaveLength(0);
  });

  it('in a week that holds it is marked, the card with its badge', () => {
    renderScene([calendar({ ...later, view: 'week', start: '2026-10-19', days: 7 }), noteOn('later')]);
    expect(markedItems(scene(), 'calendar')).toEqual(['later']);
    expect(scene().querySelectorAll('.content-rail .annotation-card .note-badge')).toHaveLength(1);
  });
});

// A rail note about a point of a chart in the aux row named the point
// ("TARGET / b") while the cell drew the chart with nothing marked: the
// card's words pointed at nothing on screen (last-gaps review L9).
describe('a chart beside the primary marks the point the rail note names', () => {
  it('rings the point in its cell while the rail shows that note', () => {
    const trend: ControllerAction = { op: 'show', id: 'trend', type: 'chart', role: 'secondary', data: { title: 'TREND', labels: ['a', 'b', 'c'], series: [{ name: 'S', values: [1, 3, 2] }] } };
    const onPoint: ControllerAction = { op: 'show', id: 'point-note', type: 'note', data: { tag: 'PEAK', anchor: { target: 'trend', x: 1 }, segments: [{ text: 'The peak.' }] } };
    renderScene([table, trend, onPoint]);
    expect(scene().querySelector('.content-rail .annotation-card__anchor')?.textContent).toBe('TARGET / b');
    // No leader reaches it in the cell: a hollow ring marks it, on the line.
    const ring = scene().querySelector('.composed-aux .chart-note-ring');
    const point = chartSeriesPoint({ title: 'TREND', labels: ['a', 'b', 'c'], series: [{ name: 'S', values: [1, 3, 2] }] }, 1);
    expect(Number(ring?.getAttribute('cx'))).toBeCloseTo(point!.x, 3);
  });
});
