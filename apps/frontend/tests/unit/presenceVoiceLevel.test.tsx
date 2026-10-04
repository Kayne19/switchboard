// @vitest-environment jsdom
// Every scene's Damocles presence follows the caller's voice (#120). The
// presence reads the level from the registered voice runtime itself, so no
// scene can leave it out; a composed scene (a metric with a note) once did,
// and its bars fell back to the canned loop.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { sceneKind, type SceneKind } from '../../src/app/sceneModel';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { mapVoiceLevelToBar } from '../../src/primitives/VoiceIndicator';

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
  ['image', fixtures.figure],
  ['composed', composed],
];

let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[];

function Scene({ actions }: { actions: ControllerAction[] }) {
  const { run, registerVoiceRuntime, state } = useController();
  useEffect(() => {
    registerVoiceRuntime({ toggleTurn: () => {}, sendText: () => true, getVoiceLevel: () => 1 });
    run([...actions, { op: 'listen', on: true }]);
  }, [actions, run, registerVoiceRuntime]);
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
  vi.unstubAllGlobals();
});

describe('the presence on every scene', () => {
  it.each(scenes)('follows the voice level on the %s scene', (kind, actions) => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
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
    // The bars settle on the scale the live level maps to; the canned loop
    // they fall back to without a level never reaches it.
    act(() => {
      for (let step = 0; step < 60; step += 1) {
        for (const frame of frames.splice(0)) frame(step * 16);
      }
    });
    const bars = host.querySelectorAll<HTMLElement>('[data-testid="damocles-presence"] .voice-indicator__bars i');
    expect(bars.length).toBeGreaterThan(0);
    bars.forEach((bar, index) => {
      const scale = Number(/^scaleY\(([\d.]+)\)$/.exec(bar.style.transform)?.[1]);
      expect(scale).toBeCloseTo(mapVoiceLevelToBar(1, index), 3);
    });
  });
});
