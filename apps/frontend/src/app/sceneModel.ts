import type {
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
} from '../controller/types';

export function orderedObjects(state: ControllerState): SceneObject[] {
  return state.order.map((id) => state.objects[id]).filter(Boolean);
}

export function objectsOfType<T>(state: ControllerState, type: SceneObjectType): Array<SceneObject<T>> {
  return orderedObjects(state).filter((object) => object.type === type) as Array<SceneObject<T>>;
}

export function primaryObject(state: ControllerState): SceneObject | null {
  const objects = orderedObjects(state);
  return objects.find((object) => object.role === 'primary') ?? objects.find((object) => !['metric', 'progress', 'note'].includes(object.type)) ?? null;
}

export type SceneKind = 'idle' | 'conversation' | 'training' | 'architecture' | 'document' | 'code';

export function sceneKind(state: ControllerState): SceneKind {
  const primary = primaryObject(state);
  if (!primary) return 'idle';
  if (primary.type === 'message') return 'conversation';
  if (primary.type === 'chart') return 'training';
  if (primary.type === 'diagram') return 'architecture';
  if (primary.type === 'document') return 'document';
  if (primary.type === 'code') return 'code';
  return 'idle';
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
