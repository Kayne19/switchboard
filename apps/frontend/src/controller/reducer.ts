import type {
  ControllerAction,
  ControllerState,
  SceneObject,
  SpeechState,
  WorkspaceState,
} from './types';
import { RUNTIME_ID_PREFIX } from './types';

export const PROTOCOL_OPERATIONS = ['show', 'hide', 'say', 'focus', 'listen', 'clear'] as const;

export function normalizeViewTarget(target: string | null | undefined): string | null {
  if (!target) return null;
  const t = target.trim().toLowerCase();
  switch (t) {
    case 'auto':
    case 'overview':
    case 'grid':
    case 'split':
      return 'auto';
    case 'system':
    case 'magi':
    case 'routing':
    case 'bay1':
      return 'system';
    case 'visual':
    case 'stage':
    case 'bay2':
      return 'visual';
    case 'comms':
    case 'transcript':
    case 'bay3':
      return 'comms';
    case 'theater':
      return 'theater';
    default:
      return t;
  }
}

function computeEffectiveView(requested: string | null, hasVisual: boolean): string {
  const req = requested ?? 'auto';
  if ((req === 'visual' || req === 'theater') && !hasVisual) {
    return 'auto';
  }
  return req;
}

export function createInitialWorkspaceState(): WorkspaceState {
  return {
    requestedView: null,
    effectiveView: 'auto',
    callerPinned: false,
    stale: false,
  };
}

export function createInitialState(): ControllerState {
  return {
    agentObjects: {},
    agentOrder: [],
    agentSpeech: null,
    runtimeObjects: {},
    runtimeOrder: [],
    runtimeSpeech: null,
    objects: {},
    order: [],
    speech: null,
    workspace: createInitialWorkspaceState(),
    activity: null,
    listening: false,
    focusId: null,
    revision: 0,
  };
}

// The most metrics the primary cluster holds: three rows of three. The
// cluster grid has a designed layout for up to this many at every stage
// geometry; one more would spill out of the main column and be clipped.
export const MAX_PRIMARY_METRICS = 9;

// Primary claimant semantics (#38):
// A metric claiming primary while metrics hold it joins them in a cluster.
// A non-metric claim demotes all primary metrics.
// A metric claim while a non-metric holds primary demotes the non-metric.
// A metric claim that would grow the cluster past MAX_PRIMARY_METRICS demotes
// its earliest claimant, so the latest claim always reaches the viewport.
// Removing one metric leaves the rest primary.
// Cluster order is stable (claim order).
// The backend's DisplayProjection applies the same rule, so /view and this
// page agree on which objects are primary.
function withPrimaryClaimedBy(
  objects: Record<string, SceneObject>,
  claimantId: string,
): Record<string, SceneObject> {
  const claimant = objects[claimantId];
  if (!claimant) return objects;
  const isMetricClaim = claimant.type === 'metric';
  const result = { ...objects };
  const clusterMates: SceneObject[] = [];
  for (const [id, object] of Object.entries(objects)) {
    if (id !== claimantId && object.role === 'primary') {
      if (!isMetricClaim || object.type !== 'metric') {
        result[id] = { ...object, role: 'secondary', primaryClaimedAt: undefined };
      } else {
        clusterMates.push(object);
      }
    }
  }
  clusterMates.sort((a, b) => (a.primaryClaimedAt ?? 0) - (b.primaryClaimedAt ?? 0));
  for (const evicted of clusterMates.slice(0, Math.max(0, clusterMates.length - (MAX_PRIMARY_METRICS - 1)))) {
    result[evicted.id] = { ...evicted, role: 'secondary', primaryClaimedAt: undefined };
  }
  return result;
}

function syncCombinedState(
  state: ControllerState,
  agentObjects: Record<string, SceneObject>,
  agentOrder: string[],
  agentSpeech: SpeechState | null,
  runtimeObjects: Record<string, SceneObject>,
  runtimeOrder: string[],
  runtimeSpeech: SpeechState | null,
  workspace: WorkspaceState,
  focusId: string | null,
  listening: boolean,
  revision: number,
): ControllerState {
  const objects: Record<string, SceneObject> = { ...agentObjects, ...runtimeObjects };
  const order: string[] = [...agentOrder];
  for (const id of runtimeOrder) {
    if (!order.includes(id)) order.push(id);
  }
  const speech = agentSpeech ?? runtimeSpeech;
  const hasVisual = agentOrder.length > 0;
  const effectiveView = computeEffectiveView(workspace.requestedView, hasVisual);
  const updatedWorkspace: WorkspaceState = {
    ...workspace,
    effectiveView,
  };

  return {
    agentObjects,
    agentOrder,
    agentSpeech,
    runtimeObjects,
    runtimeOrder,
    runtimeSpeech,
    objects,
    order,
    speech,
    workspace: updatedWorkspace,
    activity: state.activity,
    focusId,
    listening,
    revision,
  };
}

export function controllerReducer(state: ControllerState, action: ControllerAction): ControllerState {
  const revision = state.revision + 1;
  const now = Date.now();

  switch (action.op) {
    case 'runtime_show':
    case 'show': {
      if (!action.id || !action.type) return state;
      const isRuntime = action.op === 'runtime_show' || action.id.startsWith(RUNTIME_ID_PREFIX);
      if (isRuntime) {
        const existing = state.runtimeObjects[action.id];
        const object: SceneObject = {
          id: action.id,
          type: action.type,
          role: action.role ?? existing?.role,
          data: action.data,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const runtimeObjects = { ...state.runtimeObjects, [action.id]: object };
        const runtimeOrder = existing ? state.runtimeOrder : [...state.runtimeOrder, action.id];
        return syncCombinedState(
          state,
          state.agentObjects,
          state.agentOrder,
          state.agentSpeech,
          runtimeObjects,
          runtimeOrder,
          state.runtimeSpeech,
          state.workspace,
          state.focusId,
          state.listening,
          revision,
        );
      } else {
        const existing = state.agentObjects[action.id];
        const wasPrimary = existing?.role === 'primary';
        const role = action.role ?? existing?.role;
        // A primary that changes type claims the role again under its new
        // type, so a metric that becomes a chart cannot share the viewport
        // with the metric cluster it left.
        const isClaimingPrimary = action.role === 'primary'
          || (role === 'primary' && existing !== undefined && existing.type !== action.type);
        const primaryClaimedAt = role === 'primary'
          ? (wasPrimary ? existing?.primaryClaimedAt ?? revision : revision)
          : undefined;

        const object: SceneObject = {
          id: action.id,
          type: action.type,
          role,
          data: action.data,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          primaryClaimedAt,
        };
        const shown = { ...state.agentObjects, [action.id]: object };
        const agentObjects = isClaimingPrimary ? withPrimaryClaimedBy(shown, action.id) : shown;
        const agentOrder = existing ? state.agentOrder : [...state.agentOrder, action.id];
        return syncCombinedState(
          state,
          agentObjects,
          agentOrder,
          state.agentSpeech,
          state.runtimeObjects,
          state.runtimeOrder,
          state.runtimeSpeech,
          state.workspace,
          state.focusId,
          state.listening,
          revision,
        );
      }
    }
    case 'runtime_hide':
    case 'hide': {
      const isRuntime = action.op === 'runtime_hide' || action.id.startsWith(RUNTIME_ID_PREFIX);
      if (isRuntime) {
        if (!state.runtimeObjects[action.id]) return state;
        const runtimeObjects = { ...state.runtimeObjects };
        delete runtimeObjects[action.id];
        const runtimeOrder = state.runtimeOrder.filter((id) => id !== action.id);
        const runtimeSpeech = state.runtimeSpeech?.target === action.id ? null : state.runtimeSpeech;
        const focusId = state.focusId === action.id ? null : state.focusId;
        return syncCombinedState(
          state,
          state.agentObjects,
          state.agentOrder,
          state.agentSpeech,
          runtimeObjects,
          runtimeOrder,
          runtimeSpeech,
          state.workspace,
          focusId,
          state.listening,
          revision,
        );
      } else {
        if (!state.agentObjects[action.id]) return state;
        const agentObjects = { ...state.agentObjects };
        delete agentObjects[action.id];
        const agentOrder = state.agentOrder.filter((id) => id !== action.id);
        const agentSpeech = state.agentSpeech?.target === action.id ? null : state.agentSpeech;
        const focusId = state.focusId === action.id ? null : state.focusId;
        return syncCombinedState(
          state,
          agentObjects,
          agentOrder,
          agentSpeech,
          state.runtimeObjects,
          state.runtimeOrder,
          state.runtimeSpeech,
          state.workspace,
          focusId,
          state.listening,
          revision,
        );
      }
    }
    case 'runtime_say':
    case 'say': {
      const isRuntime = action.op === 'runtime_say' || Boolean(action.target?.startsWith(RUNTIME_ID_PREFIX));
      if (isRuntime) {
        const runtimeSpeech: SpeechState = {
          text: action.text,
          target: action.target ?? null,
          at: action.at ?? null,
        };
        return syncCombinedState(
          state,
          state.agentObjects,
          state.agentOrder,
          state.agentSpeech,
          state.runtimeObjects,
          state.runtimeOrder,
          runtimeSpeech,
          state.workspace,
          state.focusId,
          state.listening,
          revision,
        );
      } else {
        const agentSpeech: SpeechState = {
          text: action.text,
          target: action.target ?? null,
          at: action.at ?? null,
        };
        return syncCombinedState(
          state,
          state.agentObjects,
          state.agentOrder,
          agentSpeech,
          state.runtimeObjects,
          state.runtimeOrder,
          state.runtimeSpeech,
          state.workspace,
          state.focusId,
          state.listening,
          revision,
        );
      }
    }
    case 'focus': {
      const targetId = action.id && (state.agentObjects[action.id] || state.runtimeObjects[action.id])
        ? action.id
        : null;
      return { ...state, focusId: targetId, revision };
    }
    case 'listen':
      if (state.listening === action.on) return state;
      return { ...state, listening: action.on, revision };
    case 'clear': {
      // Agent clear removes agent objects, agent speech, and focusId; runtime state is preserved
      return syncCombinedState(
        state,
        {},
        [],
        null,
        state.runtimeObjects,
        state.runtimeOrder,
        state.runtimeSpeech,
        state.workspace,
        null,
        state.listening,
        revision,
      );
    }
    case 'runtime_activity': {
      // The revision only grows, so it names each call apart from the last.
      const activity = action.activity === null ? null : { ...action.activity, call: revision };
      return { ...state, activity, revision };
    }
    case 'runtime_reset': {
      // Runtime reset removes runtime state, activity included; agent state is preserved
      const reset = syncCombinedState(
        state,
        state.agentObjects,
        state.agentOrder,
        state.agentSpeech,
        {},
        [],
        null,
        state.workspace,
        state.focusId,
        state.listening,
        revision,
      );
      return { ...reset, activity: null };
    }
    case 'epoch_reset': {
      // A new epoch is a new leg. What the old leg's agent put on screen,
      // said, focused, or asked to see goes with it. The conversation is
      // the call's, not the leg's: it stays mounted so a handoff never
      // flashes the idle page, and the caller's own pin stays too.
      const workspace: WorkspaceState = state.workspace.callerPinned
        ? { ...state.workspace, stale: false }
        : createInitialWorkspaceState();
      const reset = syncCombinedState(
        state,
        {},
        [],
        null,
        state.runtimeObjects,
        state.runtimeOrder,
        state.runtimeSpeech,
        workspace,
        null,
        state.listening,
        revision,
      );
      return { ...reset, activity: null };
    }
    case 'set_view': {
      if (state.workspace.callerPinned) {
        return state;
      }
      const requested = normalizeViewTarget(action.view);
      const workspace: WorkspaceState = {
        ...state.workspace,
        requestedView: requested,
        effectiveView: computeEffectiveView(requested, state.agentOrder.length > 0),
      };
      return { ...state, workspace, revision };
    }
    case 'pin_view': {
      const requested = normalizeViewTarget(action.view);
      const callerPinned = requested !== 'auto' && requested !== null;
      const workspace: WorkspaceState = {
        ...state.workspace,
        requestedView: requested,
        callerPinned,
        effectiveView: computeEffectiveView(requested, state.agentOrder.length > 0),
      };
      return { ...state, workspace, revision };
    }
    case 'unpin_view':
    case 'auto_view': {
      const workspace: WorkspaceState = {
        ...state.workspace,
        requestedView: 'auto',
        callerPinned: false,
        effectiveView: 'auto',
      };
      return { ...state, workspace, revision };
    }
    case 'set_stale': {
      return {
        ...state,
        workspace: {
          ...state.workspace,
          stale: Boolean(action.stale),
        },
        revision,
      };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function reduceActions(initial: ControllerState, actions: readonly ControllerAction[]): ControllerState {
  return actions.reduce(controllerReducer, initial);
}
