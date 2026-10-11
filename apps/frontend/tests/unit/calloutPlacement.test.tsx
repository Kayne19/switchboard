// @vitest-environment jsdom
// Where a note about a node of the main slot's graph is shown: on the
// drawing, as a callout beside the node, or in the rail, the node carrying
// the NOTE marker (#390). One row per situation, read from the page once the
// actions have settled: what the rail carries, and what the drawing draws.
import { useEffect } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MotionGlobalConfig } from 'motion/react';
import { act } from 'react';
import { useController } from '../../src/controller/context';
import type { ControllerAction, DiagramData, DiagramObjectData, NoteData } from '../../src/controller/types';
import { topologyDiagram } from '../../src/fixtures/scenes';
import { lastScene as scene, renderScene, runActions, stubResizeObserver } from './sceneHarness';

stubResizeObserver();
// A card the rail lets go stays in the page until its exit ends; the rows
// read where each note settles, so exits end at once.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

const graph: DiagramData = {
  mode: 'graph',
  title: 'CALL PATH',
  nodes: [
    { id: 'gate', label: 'GATE' },
    { id: 'planner', label: 'PLANNER' },
    { id: 'pool', label: 'POOL' },
  ],
  edges: [
    { from: 'gate', to: 'planner' },
    { from: 'planner', to: 'pool' },
  ],
};
const diagram = (data: DiagramObjectData = graph): ControllerAction => ({ op: 'show', id: 'flow', type: 'diagram', role: 'primary', data });
const SHORT = 'The gate stamps each action.';
const LONG = 'The gate stamps each action with a sequence number, holds it until the page confirms it drew it, and only then tells the agent that the display was shown to the caller.';
const note = (data: Partial<NoteData> & { anchor?: NoteData['anchor'] }, text = SHORT, id = 'gate-note'): ControllerAction => ({
  op: 'show', id, type: 'note', data: { tag: 'GATE', anchor: { target: 'flow', node: 'gate' }, segments: [{ text }], ...data },
});
const fitting = note({});

interface Seen {
  /** The tags of the cards the rail carries. */
  rail: Array<string | null>;
  /** Whether the drawing carries a callout. */
  callout: boolean;
  /** How many nodes carry the NOTE marker. */
  markers: number;
}
function seen(): Seen {
  const page = scene();
  return {
    rail: [...page.querySelectorAll('.content-rail .annotation-card__tag')].map((tag) => tag.textContent),
    callout: page.querySelector('.diagram-callout') !== null,
    markers: page.querySelectorAll('.diagram-node__marker').length,
  };
}
// Lets a card the rail let go end its exit.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}
const ON_DRAWING: Seen = { rail: [], callout: true, markers: 0 };
const IN_RAIL: Seen = { rail: ['GATE'], callout: false, markers: 1 };

let dispatch: ((action: ControllerAction) => void) | null = null;
function Handle() {
  const controller = useController();
  useEffect(() => {
    dispatch = controller.dispatch;
  });
  return null;
}
// Straight to the controller, past validation: a diagram whose primitive
// throws stands in for a primitive bug no valid payload reaches.
function dispatchUnchecked(action: unknown) {
  act(() => dispatch!(action as ControllerAction));
}

describe('a note about a node of the main graph', () => {
  // [situation, the actions, where the note is shown]
  const rows: Array<[string, ControllerAction[], ControllerAction[], Seen]> = [
    ['arrives on a drawn graph and fits the callout', [diagram()], [fitting], ON_DRAWING],
    ['is shown with the graph and fits the callout', [diagram(), fitting], [], ON_DRAWING],
    ['is too long for the callout', [diagram()], [note({}, LONG)], IN_RAIL],
    ['has a tag too wide for the callout', [diagram()], [note({ tag: 'CURRENT EXPLANATION / ROUTING / PROJECT SESSION / HEADLESS PI' })], { ...IN_RAIL, rail: ['CURRENT EXPLANATION / ROUTING / PROJECT SESSION / HEADLESS PI'] }],
    ['names a node the graph does not hold', [diagram()], [note({ anchor: { target: 'flow', node: 'gone' } })], { rail: ['GATE'], callout: false, markers: 0 }],
    ['is about another object', [diagram()], [note({ anchor: { target: 'elsewhere', node: 'gate' } })], { rail: ['GATE'], callout: false, markers: 0 }],
    ['is about the graph, no node named', [diagram()], [note({ anchor: { target: 'flow' } })], { rail: ['GATE'], callout: false, markers: 0 }],
    ['names a node of a graph too large to read whole, which scrolls', [{ ...diagram(topologyDiagram) }], [note({ anchor: { target: 'flow', node: 'gate' } })], IN_RAIL],
    ['is hidden while on the drawing', [diagram(), fitting], [{ op: 'hide', id: 'gate-note' }], { rail: [], callout: false, markers: 0 }],
    ['grows too long while on the drawing', [diagram(), fitting], [note({}, LONG)], IN_RAIL],
    ['shrinks to fit while in the rail', [diagram(), note({}, LONG)], [fitting], ON_DRAWING],
    ['loses its node from the graph while on the drawing', [diagram(), fitting], [diagram({ ...graph, nodes: graph.nodes.filter((node) => node.id !== 'gate'), edges: [{ from: 'planner', to: 'pool' }] })], { rail: ['GATE'], callout: false, markers: 0 }],
    ['is on a graph redrawn as a sequence', [diagram(), fitting], [diagram({ mode: 'sequence', title: 'CALL PATH', actors: [{ id: 'gate', label: 'GATE' }, { id: 'pool', label: 'POOL' }], messages: [{ from: 'gate', to: 'pool', label: 'call' }] })], { rail: ['GATE'], callout: false, markers: 0 }],
  ];

  it.each(rows)('%s', async (_, before, then, where) => {
    renderScene(before);
    if (then.length > 0) runActions(then);
    await settle();
    expect(seen()).toEqual(where);
  });

  it('is shown in the rail, beside a second note, when the first is on the drawing', async () => {
    renderScene([diagram(), fitting]);
    runActions([note({ tag: 'PLANNER', anchor: { target: 'flow', node: 'planner' } }, 'The planner writes the plan.', 'planner-note')]);
    await settle();
    expect(seen()).toEqual({ rail: ['PLANNER'], callout: true, markers: 0 });
  });

  it('goes back to the rail when the graph that carried it fails to draw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderScene([diagram(), fitting], <Handle />);
    await settle();
    expect(seen()).toEqual(ON_DRAWING);
    // The graph's primitive reads `edges` unguarded.
    dispatchUnchecked({ op: 'show', id: 'flow', type: 'diagram', role: 'primary', data: { ...graph, edges: null } });
    await settle();
    expect(scene().querySelector('.surface-unavailable')?.textContent).toBe('OBJECT / UNAVAILABLE');
    expect(seen()).toEqual({ rail: ['GATE'], callout: false, markers: 0 });
    vi.mocked(console.error).mockRestore();
  });
});

// The rail drew the note until the diagram's passive effect said it placed
// the callout, then let the card go: for some 300 ms an unseen card held
// rail space and was in the accessibility tree (#390). Every card added to
// the page is caught, from the first commit on.
describe('a note the drawing carries as a callout', () => {
  // How many rail cards were added to the page while `run` ran and the page settled.
  async function railCardsAdded(run: () => void): Promise<number> {
    let added = 0;
    const count = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const cards = [...(node.matches('.annotation-card') ? [node] : []), ...node.querySelectorAll('.annotation-card')];
          added += cards.filter((card) => card.closest('.content-rail') !== null).length;
        }
      }
    };
    const watcher = new MutationObserver(count);
    watcher.observe(document.body, { childList: true, subtree: true });
    run();
    await settle();
    count(watcher.takeRecords());
    watcher.disconnect();
    return added;
  }

  it('is never mounted in the rail when it is shown with the graph', async () => {
    const cards = await railCardsAdded(() => renderScene([diagram(), fitting]));
    expect(scene().querySelector('.diagram-callout')).not.toBeNull();
    expect(cards).toBe(0);
  });

  it('is never mounted in the rail when it arrives on a drawn graph', async () => {
    renderScene([diagram()]);
    await settle();
    const cards = await railCardsAdded(() => runActions([fitting]));
    expect(scene().querySelector('.diagram-callout')).not.toBeNull();
    expect(cards).toBe(0);
  });

  it('stays out of the rail when it is updated in place', async () => {
    renderScene([diagram(), fitting]);
    await settle();
    const cards = await railCardsAdded(() => runActions([note({}, 'The gate stamps every action.')]));
    expect(scene().querySelector('.diagram-callout')?.textContent).toContain('every action');
    expect(cards).toBe(0);
  });


  // The graph is first drawn for the screen (1024 x 768 in jsdom), where it
  // carries the note, then for its own box, where it is laid out upright and
  // does not. The page reads the drawing again when it changes, in a
  // microtask: before the frame is painted, not in a later task.
  it('is given back to the rail before the first frame where the slot is too narrow to carry it', async () => {
    const restore: Array<() => void> = [];
    for (const [key, value] of [['offsetWidth', 300], ['offsetHeight', 600]] as const) {
      const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)!;
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('diagram-primitive') ? value : 0;
        },
      });
      restore.push(() => Object.defineProperty(HTMLElement.prototype, key, before));
    }
    try {
      renderScene([diagram(), fitting]);
      const flag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      flag.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      } finally {
        flag.IS_REACT_ACT_ENVIRONMENT = true;
      }
      expect(seen()).toEqual(IN_RAIL);
    } finally {
      for (const undo of restore) undo();
    }
  });
});
