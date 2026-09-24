import type {
  AgentObjectType,
  ChartData,
  CodeData,
  ControllerState,
  DiagramData,
  DocumentData,
  MessageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
  SceneObjectType,
  ScreenStateReport,
} from '../controller/types';
import { RUNTIME_CONVERSATION_ID } from '../controller/types';

export function orderedObjects(state: ControllerState): SceneObject[] {
  return state.order.map((id) => state.objects[id]).filter(Boolean);
}

export function objectsOfType<T>(state: ControllerState, type: SceneObjectType): Array<SceneObject<T>> {
  return orderedObjects(state).filter((object) => object.type === type) as Array<SceneObject<T>>;
}

export interface CompositionModel {
  primary: SceneObject | null;
  primaryMetrics: Array<SceneObject<MetricData>>;
  compare: SceneObject[];
  secondary: SceneObject[];
  ambient: SceneObject[];
  allAgentObjects: SceneObject[];
  runtimeConversation: SceneObject<MessageData> | null;
  runtimeObjects: SceneObject[];
  isGenericComposed: boolean;
  visualKind: AgentObjectType | null;
}

function messageObject(object: SceneObject | undefined): SceneObject<MessageData> | null {
  return object?.type === 'message' ? (object as SceneObject<MessageData>) : null;
}

export function buildCompositionModel(state: ControllerState): CompositionModel {
  const allAgentObjects = state.agentOrder
    .map((id) => state.agentObjects[id])
    .filter((obj): obj is SceneObject => Boolean(obj));

  // Primary metrics cluster (#38):
  // When metrics claim role "primary", they join a cluster instead of demoting
  // each other. Cluster order is stable by claim order (primaryClaimedAt).
  const primaryMetrics = allAgentObjects
    .filter((obj): obj is SceneObject<MetricData> => obj.role === 'primary' && obj.type === 'metric')
    .sort((a, b) => (a.primaryClaimedAt ?? 0) - (b.primaryClaimedAt ?? 0));

  // Determine primary:
  // If a primary metric cluster exists, the leading primary metric in claim
  // order is primary. Otherwise, the explicit primary object holding role
  // "primary", else the first non-ambient by order, else the first object.
  let primary: SceneObject | null = null;
  if (primaryMetrics.length > 0) {
    primary = primaryMetrics[0];
  } else {
    const explicitPrimary = allAgentObjects.find((obj) => obj.role === 'primary');
    if (explicitPrimary) {
      primary = explicitPrimary;
    } else {
      const firstNonAmbient = allAgentObjects.find((obj) => obj.role !== 'ambient');
      if (firstNonAmbient) {
        primary = firstNonAmbient;
      } else if (allAgentObjects.length > 0) {
        primary = allAgentObjects[0];
      }
    }
  }

  const activePrimaryMetrics =
    primaryMetrics.length > 0
      ? primaryMetrics
      : primary && primary.type === 'metric'
        ? [primary as SceneObject<MetricData>]
        : [];
  const primaryMetricIds = new Set(activePrimaryMetrics.map((m) => m.id));

  const compare: SceneObject[] = [];
  const secondary: SceneObject[] = [];
  const ambient: SceneObject[] = [];

  for (const obj of allAgentObjects) {
    if (obj.id === primary?.id || primaryMetricIds.has(obj.id)) {
      continue;
    }
    if (obj.role === 'compare') {
      compare.push(obj);
    } else if (obj.role === 'ambient') {
      ambient.push(obj);
    } else {
      secondary.push(obj);
    }
  }

  const isObjectOnlyWorkspace =
    allAgentObjects.length > 0 &&
    allAgentObjects.every((obj) => ['metric', 'progress', 'note'].includes(obj.type));

  const isGenericComposed =
    isObjectOnlyWorkspace ||
    (primary !== null && ['metric', 'progress', 'note'].includes(primary.type));

  const runtimeObjects = state.runtimeOrder
    .map((id) => state.runtimeObjects[id])
    .filter((obj): obj is SceneObject => Boolean(obj));

  // `state.objects` merges agent objects, and an agent may give any object
  // the id `message`: the fallback is a conversation only when it holds one.
  const runtimeConv =
    messageObject(state.runtimeObjects[RUNTIME_CONVERSATION_ID]) ??
    messageObject(state.runtimeObjects['conversation']) ??
    messageObject(state.objects['message']);

  let visualKind: AgentObjectType | null = null;
  if (state.focusId && state.agentObjects[state.focusId]) {
    const focused = state.agentObjects[state.focusId];
    if (focused.type !== 'message') {
      visualKind = focused.type as AgentObjectType;
    }
  } else if (primary && primary.type !== 'message') {
    visualKind = primary.type as AgentObjectType;
  }

  return {
    primary,
    primaryMetrics: activePrimaryMetrics,
    compare,
    secondary,
    ambient,
    allAgentObjects,
    runtimeConversation: runtimeConv,
    runtimeObjects,
    isGenericComposed,
    visualKind,
  };
}

export function primaryObject(state: ControllerState): SceneObject | null {
  return buildCompositionModel(state).primary;
}

export type SceneKind =
  | 'idle'
  | 'conversation'
  | 'training'
  | 'architecture'
  | 'document'
  | 'code'
  | 'composed';

export function sceneKind(state: ControllerState): SceneKind {
  if (state.workspace.effectiveView === 'comms') {
    return 'conversation';
  }
  const comp = buildCompositionModel(state);
  if (comp.isGenericComposed) {
    return 'composed';
  }
  const primary = comp.primary;
  if (!primary) {
    if (comp.runtimeConversation) return 'conversation';
    const legacyMsg = state.order.map((id) => state.objects[id]).find((o) => o?.type === 'message');
    if (legacyMsg) return 'conversation';
    return 'idle';
  }
  if (primary.type === 'message') return 'conversation';
  if (primary.type === 'chart') return 'training';
  if (primary.type === 'diagram') return 'architecture';
  if (primary.type === 'document') return 'document';
  if (primary.type === 'code') return 'code';
  return 'composed';
}

export function deriveScreenState(
  state: ControllerState,
  generation: number,
): ScreenStateReport {
  const comp = buildCompositionModel(state);
  const focused = state.focusId ? state.agentObjects[state.focusId] : null;
  const primary = comp.primary;

  let title = '';
  const candidate = focused ?? primary;
  if (candidate?.data && typeof candidate.data === 'object') {
    const data = candidate.data as Record<string, unknown>;
    if (typeof data.title === 'string') {
      title = data.title;
    } else if (typeof data.subject === 'string') {
      title = data.subject;
    } else if (typeof data.label === 'string') {
      title = data.label;
    }
  }

  return {
    view: state.workspace.effectiveView,
    pinned: state.workspace.callerPinned,
    has_visual: state.agentOrder.length > 0,
    visual_kind: comp.visualKind,
    object_ids: [...state.agentOrder],
    title,
    stale: state.workspace.stale,
    generation,
  };
}

export const cast = {
  chart: (object: SceneObject) => object as SceneObject<ChartData>,
  metric: (object: SceneObject) => object as SceneObject<MetricData>,
  progress: (object: SceneObject) => object as SceneObject<ProgressData>,
  diagram: (object: SceneObject) => object as SceneObject<DiagramData>,
  document: (object: SceneObject) => object as SceneObject<DocumentData>,
  code: (object: SceneObject) => object as SceneObject<CodeData>,
  message: (object: SceneObject) => object as SceneObject<MessageData>,
  note: (object: SceneObject) => object as SceneObject<NoteData>,
};
