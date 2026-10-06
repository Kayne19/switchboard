import { describe, expect, it } from 'vitest';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import { fixtures } from '../../src/fixtures/scenes';
import { besideVisuals, buildCompositionModel, deriveScreenState, sceneKind, VISUAL_TYPES } from '../../src/app/sceneModel';
import type { ControllerAction, SceneObjectType } from '../../src/controller/types';

const expected = {
  idle: 'idle',
  conversation: 'conversation',
  training: 'training',
  architecture: 'architecture',
  email: 'document',
  code: 'code',
  results: 'table',
  comparison: 'training',
  figure: 'image',
  plan: 'architecture',
  composed: 'architecture',
  calendar: 'calendar',
  tasks: 'tasks',
  timer: 'timer',
  weather: 'weather',
  inbox: 'inbox',
  today: 'calendar',
} as const;

describe('scene classification', () => {
  for (const [fixture, kind] of Object.entries(expected)) {
    it(`classifies ${fixture} as ${kind}`, () => {
      const state = reduceActions(createInitialState(), fixtures[fixture as keyof typeof fixtures]);
      expect(sceneKind(state)).toBe(kind);
    });
  }

  // renderObject draws the composed workspace's primary as it draws a main
  // slot's object; that holds because no visual is ever that primary.
  it('gives every visual primary a scene of its own: the composed primary is a metric, a progress or a note', () => {
    const types: SceneObjectType[] = [...VISUAL_TYPES, 'metric', 'progress', 'note'];
    const composed = types.filter((type) =>
      sceneKind(reduceActions(createInitialState(), [
        { op: 'show', id: 'x', type, role: 'primary', data: {} },
        { op: 'show', id: 'y', type: 'code', data: {} },
      ])) === 'composed');
    expect(composed).toEqual(['metric', 'progress', 'note']);
  });
});

const show = (id: string, type: 'chart' | 'table' | 'image' | 'code' | 'metric' | 'note' | 'progress', role?: 'primary' | 'compare' | 'secondary' | 'ambient'): ControllerAction => ({
  op: 'show', id, type, ...(role ? { role } : {}), data: {},
});

describe('visuals beside the primary', () => {
  it('lists every visual but the primary: compare, then secondary, then ambient, each in show order', () => {
    const state = reduceActions(createInitialState(), [
      show('ambient-chart', 'chart', 'ambient'),
      show('main', 'table', 'primary'),
      show('second-image', 'image'),
      show('compare-code', 'code', 'compare'),
      show('second-chart', 'chart', 'secondary'),
      show('compare-table', 'table', 'compare'),
    ]);
    expect(besideVisuals(buildCompositionModel(state)).map((object) => object.id)).toEqual([
      'compare-code', 'compare-table', 'second-image', 'second-chart', 'ambient-chart',
    ]);
  });

  it('leaves out what the rail carries', () => {
    const state = reduceActions(createInitialState(), [
      show('main', 'chart', 'primary'),
      show('m', 'metric', 'compare'),
      show('n', 'note'),
      show('p', 'progress', 'ambient'),
    ]);
    expect(besideVisuals(buildCompositionModel(state))).toEqual([]);
  });

  it('leaves out every metric holding the primary role', () => {
    const state = reduceActions(createInitialState(), [
      show('a', 'metric', 'primary'),
      show('b', 'metric', 'primary'),
      show('fig', 'image'),
    ]);
    expect(besideVisuals(buildCompositionModel(state)).map((object) => object.id)).toEqual(['fig']);
  });
});

// The screen-state report's `title` names what is on screen as the
// backend's view summary does (`summary`, apps/backend/src/display.rs):
// the first of a title, a subject, a label, an alt text and a place that
// the object carries as a string, a blank one as it is; '' for none.
describe('the title a screen-state report gives', () => {
  const titleOf = (type: SceneObjectType, data: Record<string, unknown>) =>
    deriveScreenState(reduceActions(createInitialState(), [{ op: 'show', id: 'x', type, role: 'primary', data }]), 1).title;

  it.each([
    ['a title before the rest', 'image', { title: 'T', alt: 'A' }, 'T'],
    ['a document by its subject', 'document', { subject: 'S', paragraphs: [] }, 'S'],
    ['a metric by its label', 'metric', { label: 'L', value: '1' }, 'L'],
    ['an image with no title by its alt text', 'image', { alt: 'A' }, 'A'],
    ['a forecast with no title by its place', 'weather', { location: 'Oslo' }, 'Oslo'],
    ['a blank title as it is, before the alt text', 'image', { title: ' ', alt: 'A' }, ' '],
    ['nothing for a note, which carries none', 'note', { tag: 'NOTE', segments: [] }, ''],
  ] as const)('names %s', (_, type, data, title) => {
    expect(titleOf(type, data)).toBe(title);
  });

  it('takes the fields in their order: title, subject, label, alt text, place', () => {
    const fields = ['title', 'subject', 'label', 'alt', 'location'] as const;
    fields.forEach((field, index) => {
      const data = Object.fromEntries(fields.slice(index).map((each) => [each, each.toUpperCase()]));
      expect(titleOf('image', data)).toBe(field.toUpperCase());
    });
  });

  it('names the focused object over the primary', () => {
    const state = reduceActions(createInitialState(), [
      { op: 'show', id: 'map', type: 'diagram', role: 'primary', data: { title: 'MAP' } },
      { op: 'show', id: 'eta', type: 'metric', data: { label: 'ETA', value: '1' } },
      { op: 'focus', id: 'eta' },
    ]);
    expect(deriveScreenState(state, 1).title).toBe('ETA');
  });
});
