import type {
  AgentObjectType,
  CalendarData,
  ChartData,
  CodeData,
  ControllerState,
  DiagramObjectData,
  DocumentData,
  ImageData,
  InboxData,
  MessageData,
  MetricData,
  NoteData,
  ProgressData,
  SceneObject,
  SceneObjectType,
  ScreenStateReport,
  TableData,
  TasksData,
  TimerData,
  WeatherData,
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

/** The note about an object: the first note shown whose anchor names it. The rail and the focus layer both take this one. */
export function anchoredNote(notes: Array<SceneObject<NoteData>>, targetId: string): SceneObject<NoteData> | undefined {
  return notes.find((note) => note.data.anchor?.target === targetId);
}

export function primaryObject(state: ControllerState): SceneObject | null {
  return buildCompositionModel(state).primary;
}

/** The content types that need a slot of their own to be read. The others
 * (metrics, notes, progress) are small enough for the rail or a compact
 * place in a scene. */
const VISUAL_TYPE_LIST = ['chart', 'diagram', 'document', 'code', 'table', 'image', 'calendar', 'tasks', 'timer', 'weather', 'inbox'] as const;
type VisualType = (typeof VISUAL_TYPE_LIST)[number];
export const VISUAL_TYPES: ReadonlySet<SceneObjectType> = new Set<SceneObjectType>(VISUAL_TYPE_LIST);
const isVisual = (type: SceneObjectType): type is VisualType => VISUAL_TYPES.has(type);

/**
 * Every visual on stage beside the primary, in the order a composition
 * places them: compare objects first, then secondary, then ambient, each in
 * show order. No composition may drop one: a scene draws the ones its main
 * slot has a place for, and the rest go in the aux row under it
 * (`components/Scenes.tsx`), so an accepted visual is never lost to the
 * layout. An ambient visual is here too: the rail has no room for a visual,
 * so it takes the last place in the row.
 */
export function besideVisuals(comp: CompositionModel): SceneObject[] {
  return [...comp.compare, ...comp.secondary, ...comp.ambient].filter((object) => VISUAL_TYPES.has(object.type));
}

/** The composition a scene is drawn as: one per visual type that can be the primary, named for its type but for the two the page drew first (a chart's training run, a diagram's architecture), and the three that are not a visual's. */
export type SceneKind = 'idle' | 'conversation' | 'composed' | 'training' | 'architecture' | Exclude<VisualType, 'chart' | 'diagram'>;

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
  if (!isVisual(primary.type)) return 'composed';
  return primary.type === 'chart' ? 'training' : primary.type === 'diagram' ? 'architecture' : primary.type;
}

// The fields an object is named by, in the order the scene frame and the
// agent's view take them (`summary` in apps/backend/src/display.rs, the
// cross-side mirror): a title, a document's subject, a metric's or a
// progress's label, an image's alt text (its title when it has none), a
// forecast's place (so is that).
const NAME_FIELDS = ['title', 'subject', 'label', 'alt', 'location'] as const;

/**
 * The names an object's data carries, in NAME_FIELDS order: each of those
 * fields that holds a string, a blank one too. Every reader takes them
 * from here: the screen-state report and the composed scene's frame take
 * the first as it is; a card's TARGET line the first that is not blank
 * (`objectName`).
 */
export function nameFields(data: unknown): string[] {
  if (data === null || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  return NAME_FIELDS.flatMap((field) => {
    const value = record[field];
    return typeof value === 'string' ? [value] : [];
  });
}

export function deriveScreenState(
  state: ControllerState,
  generation: number,
): ScreenStateReport {
  const comp = buildCompositionModel(state);
  const focused = state.focusId ? state.agentObjects[state.focusId] : null;
  const primary = comp.primary;

  return {
    view: state.workspace.effectiveView,
    pinned: state.workspace.callerPinned,
    has_visual: state.agentOrder.length > 0,
    visual_kind: comp.visualKind,
    object_ids: [...state.agentOrder],
    title: nameFields((focused ?? primary)?.data)[0] ?? '',
    stale: state.workspace.stale,
    generation,
  };
}

export const cast = {
  chart: (object: SceneObject) => object as SceneObject<ChartData>,
  metric: (object: SceneObject) => object as SceneObject<MetricData>,
  progress: (object: SceneObject) => object as SceneObject<ProgressData>,
  diagram: (object: SceneObject) => object as SceneObject<DiagramObjectData>,
  document: (object: SceneObject) => object as SceneObject<DocumentData>,
  code: (object: SceneObject) => object as SceneObject<CodeData>,
  table: (object: SceneObject) => object as SceneObject<TableData>,
  image: (object: SceneObject) => object as SceneObject<ImageData>,
  calendar: (object: SceneObject) => object as SceneObject<CalendarData>,
  tasks: (object: SceneObject) => object as SceneObject<TasksData>,
  timer: (object: SceneObject) => object as SceneObject<TimerData>,
  weather: (object: SceneObject) => object as SceneObject<WeatherData>,
  inbox: (object: SceneObject) => object as SceneObject<InboxData>,
  message: (object: SceneObject) => object as SceneObject<MessageData>,
  note: (object: SceneObject) => object as SceneObject<NoteData>,
};
