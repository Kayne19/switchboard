import { describe, expect, it } from 'vitest';
import type { DiagramData, SequenceDiagramData } from '../../src/controller/types';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import { validateControllerAction } from '../../src/controller/validation';
import { sceneKind } from '../../src/app/sceneModel';
import { fixtures, pipelineDiagram, topologyDiagram, traceDiagram } from '../../src/fixtures/scenes';
import { createLayers } from '../../src/primitives/diagramLayout';

// The hard canonical diagrams are agent-sendable: every action passes the
// same validator the page runs on a display action from the wire.
describe('hard diagram fixtures', () => {
  for (const name of ['topology', 'pipeline', 'trace'] as const) {
    it(`${name}: every action is a valid display action, drawn as a diagram scene`, () => {
      for (const action of fixtures[name]) expect(validateControllerAction(action), `${name} / ${'id' in action ? action.id : action.op}`).toMatchObject({ ok: true });
      expect(sceneKind(reduceActions(createInitialState(), fixtures[name]))).toBe('architecture');
    });
  }

  it('topology: the switchboard at the size an agent draws it, loops and all', () => {
    const data: DiagramData = topologyDiagram;
    expect(data.nodes.length).toBeGreaterThanOrEqual(20);
    expect(data.nodes.length).toBeLessThanOrEqual(24);
    const has = (from: string, to: string) => data.edges.some((edge) => edge.from === from && edge.to === to);
    // Transfer and hand back; the display frame and its confirmation.
    expect(has('pbx', 'operator') && has('operator', 'pbx')).toBe(true);
    expect(has('gate', 'projection') && has('projection', 'ws') && has('ws', 'gate')).toBe(true);
    expect(new Set(data.nodes.map((node) => node.state ?? 'todo'))).toEqual(new Set(['done', 'active', 'todo', 'blocked']));
    expect(data.edges.some((edge) => edge.active)).toBe(true);
    expect(fixtures.topology.some((action) => action.op === 'show' && action.type === 'note')).toBe(true);
  });

  it('pipeline: a wide DAG, layers six to twelve wide', () => {
    const data: DiagramData = pipelineDiagram;
    expect(data.nodes.length).toBeGreaterThanOrEqual(30);
    expect(data.nodes.length).toBeLessThanOrEqual(40);
    const widths = createLayers(data.nodes, data.edges).map((layer) => layer.length);
    expect(widths.filter((width) => width >= 6).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(10);
  });

  it('trace: eight actors and some thirty messages of every kind', () => {
    const data: SequenceDiagramData = traceDiagram;
    expect(data.actors).toHaveLength(8);
    expect(data.messages.length).toBeGreaterThanOrEqual(30);
    expect(new Set(data.messages.map((message) => message.kind ?? 'call'))).toEqual(new Set(['call', 'return', 'async']));
    expect(data.messages.some((message) => message.from === message.to)).toBe(true);
    expect(data.messages.filter((message) => message.active)).toHaveLength(1);
  });
});
