import { describe, expect, it } from 'vitest';
import { buildCompositionModel, deriveScreenState, primaryObject, sceneKind } from '../../src/app/sceneModel';
import { MAX_PRIMARY_METRICS, controllerReducer, createInitialState } from '../../src/controller/reducer';
import type { ControllerAction, ControllerState, MetricData } from '../../src/controller/types';

function reduceActions(state: ControllerState, actions: ControllerAction[]): ControllerState {
  return actions.reduce(controllerReducer, state);
}

const metricA: ControllerAction = {
  op: 'show',
  id: 'metric-a',
  type: 'metric',
  role: 'primary',
  data: { label: 'CPU LOAD', value: '42%' },
};

const metricB: ControllerAction = {
  op: 'show',
  id: 'metric-b',
  type: 'metric',
  role: 'primary',
  data: { label: 'MEM USAGE', value: '68%' },
};

const metricC: ControllerAction = {
  op: 'show',
  id: 'metric-c',
  type: 'metric',
  role: 'primary',
  data: { label: 'DISK I/O', value: '12 MB/s' },
};

const chartAction: ControllerAction = {
  op: 'show',
  id: 'training-loss',
  type: 'chart',
  role: 'primary',
  data: {
    title: 'LOSS TRACE',
    series: [{ label: 'loss', points: [{ x: 1, y: 0.5 }] }],
  },
};

const diagramAction: ControllerAction = {
  op: 'show',
  id: 'sys-arch',
  type: 'diagram',
  role: 'primary',
  data: {
    title: 'ARCHITECTURE',
    mode: 'graph',
    nodes: [{ id: 'n1', label: 'Node 1' }],
    edges: [],
  },
};

describe('Primary Metric Cluster semantics (#38)', () => {
  it('allows a metric claiming primary while metrics hold it to join them', () => {
    const state = reduceActions(createInitialState(), [metricA, metricB, metricC]);

    expect(state.agentObjects['metric-a'].role).toBe('primary');
    expect(state.agentObjects['metric-b'].role).toBe('primary');
    expect(state.agentObjects['metric-c'].role).toBe('primary');

    const comp = buildCompositionModel(state);
    expect(comp.primaryMetrics.map((m) => m.id)).toEqual(['metric-a', 'metric-b', 'metric-c']);
    expect(comp.secondary.some((o) => o.type === 'metric')).toBe(false);
  });

  it('demotes all primary metrics when a non-metric claims primary', () => {
    const state = reduceActions(createInitialState(), [metricA, metricB, chartAction]);

    expect(state.agentObjects['training-loss'].role).toBe('primary');
    expect(state.agentObjects['metric-a'].role).toBe('secondary');
    expect(state.agentObjects['metric-b'].role).toBe('secondary');

    const comp = buildCompositionModel(state);
    expect(comp.primary?.id).toBe('training-loss');
    expect(comp.primaryMetrics).toEqual([]);
    expect(comp.secondary.filter((o) => o.type === 'metric').length).toBe(2);
  });

  it('demotes a non-metric when a metric claims primary', () => {
    const state = reduceActions(createInitialState(), [diagramAction, metricA]);

    expect(state.agentObjects['sys-arch'].role).toBe('secondary');
    expect(state.agentObjects['metric-a'].role).toBe('primary');

    const comp = buildCompositionModel(state);
    expect(comp.primary?.id).toBe('metric-a');
    expect(comp.primaryMetrics.map((m) => m.id)).toEqual(['metric-a']);
    expect(comp.secondary.some((o) => o.id === 'sys-arch')).toBe(true);
  });

  it('leaves remaining metrics primary when one metric is removed', () => {
    const state = reduceActions(createInitialState(), [
      metricA,
      metricB,
      metricC,
      { op: 'hide', id: 'metric-b' },
    ]);

    expect(state.agentObjects['metric-a'].role).toBe('primary');
    expect(state.agentObjects['metric-b']).toBeUndefined();
    expect(state.agentObjects['metric-c'].role).toBe('primary');

    const comp = buildCompositionModel(state);
    expect(comp.primaryMetrics.map((m) => m.id)).toEqual(['metric-a', 'metric-c']);
  });

  it('leaves remaining metrics primary when one metric role changes to secondary', () => {
    const state = reduceActions(createInitialState(), [
      metricA,
      metricB,
      { ...metricA, role: 'secondary' },
    ]);

    expect(state.agentObjects['metric-a'].role).toBe('secondary');
    expect(state.agentObjects['metric-b'].role).toBe('primary');

    const comp = buildCompositionModel(state);
    expect(comp.primaryMetrics.map((m) => m.id)).toEqual(['metric-b']);
    expect(comp.secondary.some((o) => o.id === 'metric-a')).toBe(true);
  });

  it('keeps cluster order stable (claim order) when an existing primary metric is updated', () => {
    const state = reduceActions(createInitialState(), [
      metricA,
      metricB,
      // Metric A gets updated telemetry
      {
        op: 'show',
        id: 'metric-a',
        type: 'metric',
        role: 'primary',
        data: { label: 'CPU LOAD', value: '49%' },
      },
    ]);

    const comp = buildCompositionModel(state);
    expect(comp.primaryMetrics.map((m) => m.id)).toEqual(['metric-a', 'metric-b']);
    expect((comp.primaryMetrics[0].data as MetricData).value).toBe('49%');
  });

  it('appends an existing secondary metric to the end of the cluster when it claims primary later', () => {
    const secondaryMetric: ControllerAction = {
      op: 'show',
      id: 'metric-d',
      type: 'metric',
      role: 'secondary',
      data: { label: 'NET RX', value: '1.2 Gbps' },
    };

    const state = reduceActions(createInitialState(), [
      secondaryMetric,
      metricA,
      metricB,
      // Now metric-d claims primary
      { ...secondaryMetric, role: 'primary' },
    ]);

    const comp = buildCompositionModel(state);
    // metric-a claimed primary first, then metric-b, then metric-d
    expect(comp.primaryMetrics.map((m) => m.id)).toEqual(['metric-a', 'metric-b', 'metric-d']);
  });

  it('caps the cluster: one claim past the cap demotes the earliest claimant to the rail', () => {
    const claim = (id: string, value = '1'): ControllerAction => ({
      op: 'show', id, type: 'metric', role: 'primary', data: { label: id.toUpperCase(), value },
    });
    const full = reduceActions(
      createInitialState(),
      Array.from({ length: MAX_PRIMARY_METRICS }, (_, n) => claim(`m${n}`)),
    );
    expect(buildCompositionModel(full).primaryMetrics).toHaveLength(MAX_PRIMARY_METRICS);

    // Updating a member of a full cluster evicts nobody.
    const updated = controllerReducer(full, claim('m3', '2'));
    expect(buildCompositionModel(updated).primaryMetrics.map((m) => m.id)).toEqual(
      buildCompositionModel(full).primaryMetrics.map((m) => m.id),
    );

    const overflowed = controllerReducer(updated, claim('extra'));
    const comp = buildCompositionModel(overflowed);
    expect(MAX_PRIMARY_METRICS).toBe(9);
    expect(comp.primaryMetrics.map((m) => m.id)).toEqual([
      ...Array.from({ length: MAX_PRIMARY_METRICS - 1 }, (_, n) => `m${n + 1}`),
      'extra',
    ]);
    expect(overflowed.agentObjects.m0.role).toBe('secondary');
    expect(comp.secondary.map((o) => o.id)).toEqual(['m0']);
    expect(deriveScreenState(overflowed, 1).title).toBe('M1');
  });

  it('lets a primary that changes type claim the role again under its new type', () => {
    const state = reduceActions(createInitialState(), [
      metricA,
      metricB,
      // metric-a becomes a chart without naming a role.
      { op: 'show', id: 'metric-a', type: 'chart', data: { title: 'CPU TRACE', series: [{ label: 'cpu', points: [{ x: 1, y: 0.5 }] }] } },
    ]);

    expect(state.agentObjects['metric-a'].role).toBe('primary');
    expect(state.agentObjects['metric-b'].role).toBe('secondary');
    const comp = buildCompositionModel(state);
    expect(comp.primary?.id).toBe('metric-a');
    expect(comp.primaryMetrics).toEqual([]);
    expect(deriveScreenState(state, 1).visual_kind).toBe('chart');
  });

  it('replaying the backend snapshot rebuilds show order and cluster order', () => {
    // Each case is a live action sequence and the snapshot the backend's
    // DisplayProjection replays for it; apps/backend/tests/test_api.rs
    // asserts the same snapshots.
    const metric = (id: string, role?: 'primary' | 'secondary'): ControllerAction => ({
      op: 'show', id, type: 'metric', ...(role ? { role } : {}), data: { label: id, value: '1' },
    });
    const diagram = (role: 'primary' | 'secondary'): ControllerAction => ({
      op: 'show', id: 'diag', type: 'diagram', role, data: { title: 'DIAG', mode: 'graph', nodes: [], edges: [] },
    });
    const cases: Array<{ live: ControllerAction[]; snapshot: ControllerAction[] }> = [
      {
        live: [metric('m-sec', 'secondary'), metric('m-prim', 'primary'), metric('m-sec', 'primary')],
        snapshot: [metric('m-sec'), metric('m-prim', 'primary'), metric('m-sec', 'primary')],
      },
      {
        live: [
          metric('m1', 'primary'), metric('m2', 'primary'), diagram('primary'),
          metric('m2', 'primary'), metric('m1', 'primary'),
        ],
        snapshot: [metric('m1'), metric('m2', 'primary'), diagram('secondary'), metric('m1', 'primary')],
      },
    ];

    for (const { live, snapshot } of cases) {
      const liveState = reduceActions(createInitialState(), live);
      const replayed = reduceActions(
        controllerReducer(liveState, { op: 'epoch_reset' }),
        snapshot,
      );
      expect(replayed.agentOrder).toEqual(liveState.agentOrder);
      const roles = (state: ControllerState) => state.agentOrder.map((id) => state.agentObjects[id].role);
      expect(roles(replayed)).toEqual(roles(liveState));
      expect(buildCompositionModel(replayed).primaryMetrics.map((m) => m.id)).toEqual(
        buildCompositionModel(liveState).primaryMetrics.map((m) => m.id),
      );
    }
  });

  it('truthfully derives screen state with visual_kind metric and leading primary metric label', () => {
    const state = reduceActions(createInitialState(), [metricA, metricB]);
    const report = deriveScreenState(state, 1);

    expect(report.has_visual).toBe(true);
    expect(report.visual_kind).toBe('metric');
    expect(report.title).toBe('CPU LOAD');
    expect(sceneKind(state)).toBe('composed');
    expect(primaryObject(state)?.id).toBe('metric-a');
  });
});
