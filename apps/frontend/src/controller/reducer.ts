import type { ControllerAction, ControllerState, SceneObject } from './types';

export const PROTOCOL_OPERATIONS = ['show', 'hide', 'say', 'focus', 'listen', 'clear'] as const;

export function createInitialState(): ControllerState {
  return { objects: {}, order: [], speech: null, listening: false, focusId: null, revision: 0 };
}

export function controllerReducer(state: ControllerState, action: ControllerAction): ControllerState {
  const revision = state.revision + 1;
  const now = Date.now();

  switch (action.op) {
    case 'show': {
      if (!action.id || !action.type) return state;
      const existing = state.objects[action.id];
      const object: SceneObject = {
        id: action.id,
        type: action.type,
        role: action.role ?? existing?.role,
        data: action.data,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return {
        ...state,
        objects: { ...state.objects, [action.id]: object },
        order: existing ? state.order : [...state.order, action.id],
        revision,
      };
    }
    case 'hide': {
      if (!state.objects[action.id]) return state;
      const objects = { ...state.objects };
      delete objects[action.id];
      return {
        ...state,
        objects,
        order: state.order.filter((id) => id !== action.id),
        speech: state.speech?.target === action.id ? null : state.speech,
        focusId: state.focusId === action.id ? null : state.focusId,
        revision,
      };
    }
    case 'say':
      return {
        ...state,
        speech: { text: action.text, target: action.target ?? null, at: action.at ?? null },
        revision,
      };
    case 'focus':
      return { ...state, focusId: action.id && state.objects[action.id] ? action.id : null, revision };
    case 'listen':
      return { ...state, listening: action.on, revision };
    case 'clear':
      return { ...createInitialState(), revision };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function reduceActions(initial: ControllerState, actions: readonly ControllerAction[]): ControllerState {
  return actions.reduce(controllerReducer, initial);
}
