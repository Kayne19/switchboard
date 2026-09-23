import { describe, expect, it } from 'vitest';
import { buildCompositionModel, deriveScreenState, primaryObject, sceneKind } from '../../src/app/sceneModel';
import { controllerReducer, createInitialState } from '../../src/controller/reducer';
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
