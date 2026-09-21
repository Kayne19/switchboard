import { describe, expect, it, vi } from 'vitest';
import {
  controllerReducer,
  createInitialState,
  reduceActions,
} from '../../src/controller/reducer';
import { buildCompositionModel, deriveScreenState, sceneKind } from '../../src/app/sceneModel';
import type {
  ChartData,
  CodeData,
  ControllerAction,
  DiagramData,
  DocumentData,
  MetricData,
  NoteData,
  ProgressData,
} from '../../src/controller/types';
import {
  RUNTIME_CONVERSATION_ID,
  RUNTIME_ID_PREFIX,
} from '../../src/controller/types';

const chartAction: ControllerAction = {
  op: 'show',
  id: 'training-loss',
  type: 'chart',
  role: 'primary',
  data: {
    title: 'Training Loss',
    series: [{ name: 'loss', values: [0.5, 0.4, 0.3] }],
  } as ChartData,
};

const metricAction: ControllerAction = {
  op: 'show',
  id: 'gpu',
  type: 'metric',
  role: 'ambient',
  data: { label: 'GPU', value: '91%' } as MetricData,
};

const progressAction: ControllerAction = {
  op: 'show',
  id: 'train-progress',
  type: 'progress',
  role: 'secondary',
  data: { label: 'Epoch', value: 0.75, text: '30/40' } as ProgressData,
};

const diagramAction: ControllerAction = {
  op: 'show',
  id: 'sys-arch',
  type: 'diagram',
  role: 'primary',
  data: {
    mode: 'graph',
    title: 'System Architecture',
    nodes: [
      { id: 'gw', label: 'Gateway' },
      { id: 'svc', label: 'Service' },
    ],
    edges: [{ from: 'gw', to: 'svc', label: 'HTTP' }],
  } as DiagramData,
};

const documentAction: ControllerAction = {
  op: 'show',
  id: 'memo',
  type: 'document',
  role: 'compare',
  data: {
    subject: 'Project Spec',
    paragraphs: ['Introduction paragraph.'],
  } as DocumentData,
};

const codeAction: ControllerAction = {
  op: 'show',
  id: 'patch',
  type: 'code',
  role: 'secondary',
  data: {
    title: 'Main Patch',
    file: 'main.rs',
    source: { text: 'fn main() {}' },
  } as CodeData,
};

const noteAction: ControllerAction = {
  op: 'show',
  id: 'note-1',
  type: 'note',
  role: 'secondary',
  data: {
    tag: 'NOTE',
    segments: [{ text: 'Check performance trace.' }],
  } as NoteData,
};

describe('controller reducer & ownership', () => {
  it('upserts by stable object ID without duplicating order', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    const first = controllerReducer(createInitialState(), metricAction);
    const second = controllerReducer(first, {
      ...metricAction,
      data: { label: 'GPU', value: '94%' },
    });

    expect(second.agentOrder).toEqual(['gpu']);
    expect(second.order).toEqual(['gpu']);
    expect(second.agentObjects.gpu.data).toEqual({ label: 'GPU', value: '94%' });
    expect(second.agentObjects.gpu.createdAt).toBe(100);
    expect(second.agentObjects.gpu.updatedAt).toBe(200);
    vi.restoreAllMocks();
  });

  it('removes focus and targeted speech when an object is hidden', () => {
    const state = reduceActions(createInitialState(), [
      metricAction,
      { op: 'focus', id: 'gpu' },
      { op: 'say', target: 'gpu', text: 'GPU is saturated.' },
    ]);
    const hidden = controllerReducer(state, { op: 'hide', id: 'gpu' });

    expect(hidden.agentObjects.gpu).toBeUndefined();
    expect(hidden.objects.gpu).toBeUndefined();
    expect(hidden.focusId).toBeNull();
    expect(hidden.agentSpeech).toBeNull();
    expect(hidden.speech).toBeNull();
  });

  it('does not focus an unknown object', () => {
    const state = controllerReducer(createInitialState(), { op: 'focus', id: 'missing' });
    expect(state.focusId).toBeNull();
  });

  it('supports all seven structured types in compositions', () => {
    const state = reduceActions(createInitialState(), [
      chartAction,
      metricAction,
      progressAction,
      diagramAction,
      documentAction,
      codeAction,
      noteAction,
    ]);

    expect(state.agentOrder.length).toBe(7);
    expect(state.agentObjects['training-loss'].type).toBe('chart');
    expect(state.agentObjects['gpu'].type).toBe('metric');
    expect(state.agentObjects['train-progress'].type).toBe('progress');
    expect(state.agentObjects['sys-arch'].type).toBe('diagram');
    expect(state.agentObjects['memo'].type).toBe('document');
    expect(state.agentObjects['patch'].type).toBe('code');
    expect(state.agentObjects['note-1'].type).toBe('note');

    const comp = buildCompositionModel(state);
    expect(comp.allAgentObjects.length).toBe(7);
    // chartAction was first primary
    expect(comp.primary?.id).toBe('training-loss');
    expect(comp.compare.some((o) => o.id === 'memo')).toBe(true);
    expect(comp.ambient.some((o) => o.id === 'gpu')).toBe(true);
  });

  it('resolves primary by explicit role, tie-breaking by order', () => {
    // Both chart and diagram have role: 'primary'. chart is first by order.
    const state = reduceActions(createInitialState(), [chartAction, diagramAction]);
    const comp = buildCompositionModel(state);
    expect(comp.primary?.id).toBe('training-loss');

    // If diagram is added first, diagram is primary
    const reversed = reduceActions(createInitialState(), [diagramAction, chartAction]);
    const compReversed = buildCompositionModel(reversed);
    expect(compReversed.primary?.id).toBe('sys-arch');
  });

  it('resolves primary to first non-ambient object when no explicit primary exists', () => {
    const obj1: ControllerAction = { op: 'show', id: 'm1', type: 'metric', role: 'ambient', data: { label: 'A', value: '1' } };
    const obj2: ControllerAction = { op: 'show', id: 'n1', type: 'note', role: 'secondary', data: { segments: [{ text: 'B' }] } };
    const state = reduceActions(createInitialState(), [obj1, obj2]);
    const comp = buildCompositionModel(state);
    expect(comp.primary?.id).toBe('n1');
  });

  it('handles metric/progress/note-only scenes via generic composed workspace', () => {
    const state = reduceActions(createInitialState(), [metricAction, progressAction, noteAction]);
    const comp = buildCompositionModel(state);
    expect(comp.isGenericComposed).toBe(true);
    expect(sceneKind(state)).toBe('composed');
  });

  it('separates agent-owned objects/speech from runtime-owned state', () => {
    const runtimeConv: ControllerAction = {
      op: 'runtime_show',
      id: RUNTIME_CONVERSATION_ID,
      type: 'message',
      role: 'secondary',
      data: { segments: [{ text: 'Runtime line active' }] },
    };
    const runtimeSay: ControllerAction = {
      op: 'runtime_say',
      text: 'Damocles speaking',
      target: RUNTIME_CONVERSATION_ID,
    };
    const state = reduceActions(createInitialState(), [
      metricAction,
      { op: 'say', text: 'Agent explanation', target: 'gpu' },
      { op: 'listen', on: true },
      runtimeConv,
      runtimeSay,
    ]);

    expect(state.agentObjects.gpu).toBeDefined();
    expect(state.runtimeObjects[RUNTIME_CONVERSATION_ID]).toBeDefined();
    expect(state.agentSpeech?.text).toBe('Agent explanation');
    expect(state.runtimeSpeech?.text).toBe('Damocles speaking');
    expect(state.listening).toBe(true);

    // Agent clear removes agent objects and agent speech, but preserves runtime state
    const afterAgentClear = controllerReducer(state, { op: 'clear' });
    expect(afterAgentClear.agentObjects).toEqual({});
    expect(afterAgentClear.agentOrder).toEqual([]);
    expect(afterAgentClear.agentSpeech).toBeNull();
    expect(afterAgentClear.runtimeObjects[RUNTIME_CONVERSATION_ID]).toBeDefined();
    expect(afterAgentClear.runtimeSpeech?.text).toBe('Damocles speaking');
    expect(afterAgentClear.listening).toBe(true);

    // Runtime reset removes runtime state, preserves agent state
    const afterRuntimeReset = controllerReducer(state, { op: 'runtime_reset' });
    expect(afterRuntimeReset.agentObjects.gpu).toBeDefined();
    expect(afterRuntimeReset.agentSpeech?.text).toBe('Agent explanation');
    expect(afterRuntimeReset.runtimeObjects).toEqual({});
    expect(afterRuntimeReset.runtimeSpeech).toBeNull();

    // Epoch reset clears both
    const afterEpochReset = controllerReducer(state, { op: 'epoch_reset' });
    expect(afterEpochReset.agentObjects).toEqual({});
    expect(afterEpochReset.runtimeObjects).toEqual({});
    expect(afterEpochReset.agentSpeech).toBeNull();
    expect(afterEpochReset.runtimeSpeech).toBeNull();
  });

  it('routes IDs prefixed with __runtime/ into runtime namespace', () => {
    const internalAction: ControllerAction = {
      op: 'show',
      id: `${RUNTIME_ID_PREFIX}live-visual`,
      type: 'diagram',
      data: { mode: 'graph', nodes: [], edges: [] },
    };
    const state = controllerReducer(createInitialState(), internalAction);
    expect(state.runtimeObjects[`${RUNTIME_ID_PREFIX}live-visual`]).toBeDefined();
    expect(state.agentObjects[`${RUNTIME_ID_PREFIX}live-visual`]).toBeUndefined();
  });

  it('manages workspace view/pin/stale state transitions and precedence', () => {
    let state = createInitialState();
    expect(state.workspace.requestedView).toBeNull();
    expect(state.workspace.callerPinned).toBe(false);
    expect(state.workspace.effectiveView).toBe('auto');

    // Server requests view 'visual' with no visual present -> falls back to 'auto'
    state = controllerReducer(state, { op: 'set_view', view: 'visual' });
    expect(state.workspace.requestedView).toBe('visual');
    expect(state.workspace.effectiveView).toBe('auto');

    // Show a visual object -> effectiveView becomes 'visual'
    state = controllerReducer(state, chartAction);
    expect(state.workspace.effectiveView).toBe('visual');

    // Caller pins view to 'comms'
    state = controllerReducer(state, { op: 'pin_view', view: 'comms' });
    expect(state.workspace.requestedView).toBe('comms');
    expect(state.workspace.callerPinned).toBe(true);
    expect(state.workspace.effectiveView).toBe('comms');

    // Server view request is ignored while callerPinned is true
    state = controllerReducer(state, { op: 'set_view', view: 'theater' });
    expect(state.workspace.requestedView).toBe('comms');
    expect(state.workspace.effectiveView).toBe('comms');

    // Caller sets Auto -> unpins
    state = controllerReducer(state, { op: 'auto_view' });
    expect(state.workspace.callerPinned).toBe(false);
    expect(state.workspace.requestedView).toBe('auto');
    expect(state.workspace.effectiveView).toBe('auto');

    // Toggle stale flag
    state = controllerReducer(state, { op: 'set_stale', stale: true });
    expect(state.workspace.stale).toBe(true);
    state = controllerReducer(state, { op: 'set_stale', stale: false });
    expect(state.workspace.stale).toBe(false);
  });

  it('derives authoritative screen_state report correctly', () => {
    let state = reduceActions(createInitialState(), [
      chartAction,
      progressAction,
      { op: 'set_view', view: 'visual' },
    ]);
    let report = deriveScreenState(state, 5);
    expect(report.generation).toBe(5);
    expect(report.has_visual).toBe(true);
    expect(report.visual_kind).toBe('chart');
    expect(report.object_ids).toEqual(['training-loss', 'train-progress']);
    expect(report.title).toBe('Training Loss');
    expect(report.view).toBe('visual');
    expect(report.pinned).toBe(false);
    expect(report.stale).toBe(false);

    // Focus overrides visual_kind and title
    state = controllerReducer(state, { op: 'focus', id: 'train-progress' });
    report = deriveScreenState(state, 5);
    expect(report.visual_kind).toBe('progress');
    expect(report.title).toBe('Epoch');
  });
});
