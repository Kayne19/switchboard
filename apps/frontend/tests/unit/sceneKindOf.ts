// The scene kind the page draws for a state: the composition built once,
// as SceneRenderer builds it, and the view the workspace is in. For the
// tests that ask what a state would draw without mounting the page.
import { buildCompositionModel, sceneKind, type SceneKind } from '../../src/app/sceneModel';
import type { ControllerState } from '../../src/controller/types';

export function sceneKindOf(state: ControllerState): SceneKind {
  return sceneKind(buildCompositionModel(state), state.workspace.effectiveView);
}
