import { describe, expect, it } from 'vitest';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import { fixtures } from '../../src/fixtures/scenes';
import { besideVisuals, buildCompositionModel, deriveScreenState, VISUAL_TYPES } from '../../src/app/sceneModel';
import { sceneKindOf } from './sceneKindOf';
import type { ControllerAction, SceneObjectType } from '../../src/controller/types';
import type { ViewName } from '../../src/protocol';

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
      expect(sceneKindOf(state)).toBe(kind);
    });
  }

  // renderObject draws the composed workspace's primary as it draws a main
  // slot's object; that holds because no visual is ever that primary.
  it('gives every visual primary a scene of its own: the composed primary is a metric, a progress or a note', () => {
    const types: SceneObjectType[] = [...VISUAL_TYPES, 'metric', 'progress', 'note'];
    const composed = types.filter((type) =>
      sceneKindOf(reduceActions(createInitialState(), [
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

// What the page draws for each view an agent may ask for (`view(target)`,
// every name `module_calls.rs` takes), and what its screen-state report
// says it shows: the report names the view the page draws, never one it
// was asked for and does not draw (#277). One row per request and stage.
describe('the view a screen-state report names is the one the page draws', () => {
  const chart: ControllerAction = { op: 'show', id: 'loss', type: 'chart', role: 'primary', data: { title: 'Loss', series: [] } };
  const stages = { empty: [] as ControllerAction[], chart: [chart] };
  // request -> stage -> [scene kind drawn, view reported]
  const table: Record<ViewName, Record<keyof typeof stages, [string, string]>> = {
    auto: { empty: ['idle', 'auto'], chart: ['training', 'auto'] },
    visual: { empty: ['idle', 'auto'], chart: ['training', 'visual'] },
    comms: { empty: ['conversation', 'comms'], chart: ['conversation', 'comms'] },
    system: { empty: ['system', 'system'], chart: ['system', 'system'] },
    theater: { empty: ['idle', 'auto'], chart: ['theater', 'theater'] },
  };
  const requests = (Object.keys(table) as ViewName[]).map((view) => [view, view] as const);

  for (const [request, view] of requests) {
    for (const stage of Object.keys(stages) as Array<keyof typeof stages>) {
      const [kind, reported] = table[view][stage];
      it(`${request} on the ${stage} stage draws ${kind} and reports ${reported}`, () => {
        const state = reduceActions(createInitialState(), [...stages[stage], { op: 'set_view', view: request }]);
        expect([sceneKindOf(state), deriveScreenState(state, 1).view]).toEqual([kind, reported]);
      });
    }
  }

  // The reported view, asked for on the same stage, draws what is on
  // screen: an agent that asks for the view it was told it has changes
  // nothing.
  it('draws the same scene when the reported view is asked for', () => {
    for (const [request] of requests) {
      for (const stage of Object.values(stages)) {
        const state = reduceActions(createInitialState(), [...stage, { op: 'set_view', view: request }]);
        const again = reduceActions(createInitialState(), [...stage, { op: 'set_view', view: deriveScreenState(state, 1).view as ViewName }]);
        expect(sceneKindOf(again), request).toBe(sceneKindOf(state));
      }
    }
  });
});
