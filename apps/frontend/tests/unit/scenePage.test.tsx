// @vitest-environment jsdom
// Every page draws the parts every page has once (#121): one Damocles
// presence, and the tool activity panel while the agent runs a tool. The
// idle page shows no activity panel.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { sceneKind, type SceneKind } from '../../src/app/sceneModel';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

const composed: ControllerAction[] = [
  { op: 'show', id: 'latency', type: 'metric', role: 'primary', data: { label: 'P95 LATENCY', value: '182 ms' } },
  { op: 'show', id: 'latency-note', type: 'note', data: { tag: 'NOTE / 01', segments: [{ text: 'Up since the deploy.' }] } },
];

const scenes: Array<[SceneKind, ControllerAction[]]> = [
  ['idle', fixtures.idle],
  ['conversation', fixtures.conversation],
  ['training', fixtures.training],
  ['architecture', fixtures.architecture],
  ['document', fixtures.email],
  ['code', fixtures.code],
  ['table', fixtures.results],
  ['composed', composed],
];

const tool: ControllerAction = { op: 'runtime_activity', activity: { label: 'READ', tool: 'read', detail: 'src/main.rs' }, at: 0 };

let host: HTMLDivElement;
let root: Root;

function Scene({ actions }: { actions: ControllerAction[] }) {
  const { run, state } = useController();
  useEffect(() => run([...actions, tool]), [actions, run]);
  return <div data-kind={sceneKind(state)} />;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('every page', () => {
  it.each(scenes)('draws one presence and its tool activity on the %s page', (kind, actions) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(
      <ControllerProvider>
        <Scene actions={actions} />
        <SceneRenderer />
      </ControllerProvider>,
    ));
    expect(host.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe(kind);
    const page = host.querySelector(`[data-scene="${kind}"]`)!;
    expect(page).not.toBeNull();
    expect(page.querySelectorAll('[data-testid="damocles-presence"]')).toHaveLength(1);
    expect(page.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(kind === 'idle' ? 0 : 1);
  });
});
