// @vitest-environment jsdom
// One malformed object must not blank the display (issue #34). An agent may
// give any object the id `message`, and the conversation view must not read
// such an object as a chat turn.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCompositionModel } from '../../src/app/sceneModel';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let dispatch: (action: ControllerAction) => void;
// Every error the page would report: thrown out of React, or caught by a
// boundary on the way.
let pageErrors: unknown[];

function onWindowError(event: ErrorEvent) {
  pageErrors.push(event.error ?? event.message);
}

function ControllerHandle() {
  dispatch = useController().dispatch;
  return null;
}

function mountStage(): HTMLDivElement {
  const stage = document.createElement('div');
  document.body.append(stage);
  const stageRoot = createRoot(stage, {
    onUncaughtError: (error) => pageErrors.push(error),
    onCaughtError: (error) => pageErrors.push(error),
  });
  host = stage;
  root = stageRoot;
  act(() =>
    stageRoot.render(
      <ControllerProvider>
        <SceneRenderer />
        <ControllerHandle />
      </ControllerProvider>,
    ),
  );
  return stage;
}

function send(...actions: ControllerAction[]) {
  for (const action of actions) act(() => dispatch(action));
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  pageErrors = [];
  window.addEventListener('error', onWindowError);
});

afterEach(() => {
  window.removeEventListener('error', onWindowError);
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const queueMetric: ControllerAction = {
  op: 'show',
  id: 'message',
  type: 'metric',
  role: 'primary',
  data: { label: 'QUEUE', value: '12' },
};

describe('the conversation fallback', () => {
  it('does not take an agent object named message of another type', () => {
    const state = reduceActions(createInitialState(), [queueMetric]);
    expect(buildCompositionModel(state).runtimeConversation).toBeNull();
  });

  it('still takes an agent message named message when there is no runtime conversation', () => {
    const state = reduceActions(createInitialState(), fixtures.conversation);
    const conversation = buildCompositionModel(state).runtimeConversation;
    expect(conversation?.id).toBe('message');
    expect(conversation?.type).toBe('message');
  });

  it('renders the conversation view over an agent metric named message with no error', () => {
    const stage = mountStage();
    // Nothing that reaches comms today does so without a runtime
    // conversation; a caller pin would be the first path that does.
    send(queueMetric, { op: 'pin_view', view: 'comms' });

    expect(stage.querySelector('[data-scene="conversation"]')).not.toBeNull();
    expect(stage.querySelector('.conversation-answer__text')?.textContent).toBe('Line open. Speak when ready.');
    expect(pageErrors).toEqual([]);
  });

  it('renders an agent message named message in the conversation view', () => {
    const stage = mountStage();
    send(...fixtures.conversation);

    expect(stage.querySelector('[data-scene="conversation"]')).not.toBeNull();
    const conversation = buildCompositionModel(reduceActions(createInitialState(), fixtures.conversation)).runtimeConversation;
    const firstWords = conversation?.data.segments[0]?.text ?? '';
    expect(firstWords).not.toBe('');
    expect(stage.querySelector('.conversation-answer__text')?.textContent).toContain(firstWords);
    expect(pageErrors).toEqual([]);
  });
});
