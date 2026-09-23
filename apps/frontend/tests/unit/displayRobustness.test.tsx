// @vitest-environment jsdom
// One malformed object must not blank the display (issue #34). An agent may
// give any object the id `message`, and the conversation view must not read
// such an object as a chat turn; and a surface that throws while rendering
// degrades alone instead of unmounting the stage.
//
// Validation keeps malformed data off the wire, so the broken objects here
// are dispatched straight to the controller: they stand in for a primitive
// bug, which no valid payload can reach.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { buildCompositionModel } from '../../src/app/sceneModel';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ControllerAction, ControllerState } from '../../src/controller/types';
import { RUNTIME_CONVERSATION_ID } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let dispatch: (action: ControllerAction) => void;
let latest: ControllerState;
// Errors thrown out of React entirely, which unmount the whole page.
let uncaughtErrors: unknown[];
// Errors a boundary caught on the way.
let caughtErrors: unknown[];

function onWindowError(event: ErrorEvent) {
  uncaughtErrors.push(event.error ?? event.message);
}

function ControllerHandle() {
  const controller = useController();
  dispatch = controller.dispatch;
  latest = controller.state;
  return null;
}

function mount(page: ReactNode): HTMLDivElement {
  const stage = document.createElement('div');
  document.body.append(stage);
  const pageRoot = createRoot(stage, {
    onUncaughtError: (error) => uncaughtErrors.push(error),
    onCaughtError: (error) => caughtErrors.push(error),
  });
  host = stage;
  root = pageRoot;
  act(() =>
    pageRoot.render(
      <ControllerProvider>
        {page}
        <ControllerHandle />
      </ControllerProvider>,
    ),
  );
  return stage;
}

function mountStage(): HTMLDivElement {
  return mount(<SceneRenderer />);
}

function send(...actions: ControllerAction[]) {
  for (const action of actions) act(() => dispatch(action));
}

function click(element: Element | null) {
  if (!element) throw new Error('nothing to click');
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
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
  uncaughtErrors = [];
  caughtErrors = [];
  window.addEventListener('error', onWindowError);
  // A caught render error is logged; keep the run's output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  window.removeEventListener('error', onWindowError);
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.restoreAllMocks();
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
    expect(uncaughtErrors).toEqual([]);
    expect(caughtErrors).toEqual([]);
  });

  it('renders an agent message named message in the conversation view', () => {
    const stage = mountStage();
    send(...fixtures.conversation);

    expect(stage.querySelector('[data-scene="conversation"]')).not.toBeNull();
    const conversation = buildCompositionModel(reduceActions(createInitialState(), fixtures.conversation)).runtimeConversation;
    const firstWords = conversation?.data.segments[0]?.text ?? '';
    expect(firstWords).not.toBe('');
    expect(stage.querySelector('.conversation-answer__text')?.textContent).toContain(firstWords);
    expect(uncaughtErrors).toEqual([]);
    expect(caughtErrors).toEqual([]);
  });
});

// A chart whose primitive throws: ChartPrimitive reads `series` unguarded.
const brokenChart = {
  op: 'show',
  id: 'loss',
  type: 'chart',
  role: 'primary',
  data: { title: 'LOSS', series: null },
} as unknown as ControllerAction;

const validChart: ControllerAction = {
  op: 'show',
  id: 'loss',
  type: 'chart',
  role: 'primary',
  data: { title: 'LOSS', series: [{ name: 'TRAIN', values: [3, 2, 1] }] },
};

const gpuMetric: ControllerAction = {
  op: 'show',
  id: 'gpu',
  type: 'metric',
  data: { label: 'GPU', value: '94%' },
};

describe('a primitive that throws during render', () => {
  it('leaves the rest of the stage mounted', () => {
    const stage = mountStage();
    send(brokenChart, gpuMetric);

    expect(uncaughtErrors).toEqual([]);
    expect(stage.querySelector('[data-scene="training"]')).not.toBeNull();
    expect(stage.querySelector('.scene-heading__title')?.textContent).toBe('LOSS');
    expect(stage.querySelector('[data-testid="damocles-presence"]')).not.toBeNull();
    expect(stage.querySelector('.content-rail [data-testid="metrics"]')?.textContent).toContain('GPU');

    // Only the chart's own surface degrades, inside its frame.
    const surface = stage.querySelector('.chart-object');
    expect(surface?.querySelector('.tech-frame')).not.toBeNull();
    expect(surface?.querySelector('.surface-unavailable')?.textContent).toBe('OBJECT / UNAVAILABLE');
    expect(surface?.querySelector('[data-testid="chart"]')).toBeNull();
  });

  it('logs the failure with the id of the object that failed', () => {
    mountStage();
    send(brokenChart);

    expect(caughtErrors.length).toBeGreaterThan(0);
    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('loss'))).toBe(true);
  });

  it('recovers when the object is replaced with valid data', () => {
    const stage = mountStage();
    send(brokenChart, gpuMetric);
    send(validChart);

    expect(stage.querySelector('.chart-object [data-testid="chart"]')).not.toBeNull();
    expect(stage.querySelector('.surface-unavailable')).toBeNull();
    expect(uncaughtErrors).toEqual([]);
  });

  it('degrades inside the focus layer when the broken object is focused', () => {
    const stage = mountStage();
    send(brokenChart, gpuMetric, { op: 'focus', id: 'loss' });

    expect(uncaughtErrors).toEqual([]);
    const layer = stage.querySelector('.focus-layer');
    expect(layer?.querySelector('.surface-unavailable')?.textContent).toBe('OBJECT / UNAVAILABLE');
    // The way back out stays.
    expect(layer?.querySelector('button')?.textContent).toBe('RETURN / ESC');
    expect(stage.querySelector('[data-scene="training"]')).not.toBeNull();
  });
});

// A diagram with no data: the architecture scene itself reads its title,
// outside any one object's surface.
const brokenDiagram = {
  op: 'show',
  id: 'map',
  type: 'diagram',
  role: 'primary',
  data: null,
} as unknown as ControllerAction;

const validDiagram: ControllerAction = {
  op: 'show',
  id: 'map',
  type: 'diagram',
  role: 'primary',
  data: {
    mode: 'graph',
    title: 'CALL PATH',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b' }],
  },
};

describe('a scene that throws during render', () => {
  it('keeps the presence on stage, and the presence still drives listening', () => {
    const stage = mountStage();
    send(brokenDiagram);

    expect(uncaughtErrors).toEqual([]);
    expect(stage.querySelector('main.stage')).not.toBeNull();
    expect(stage.querySelector('.stage-unavailable')?.textContent).toBe('DISPLAY / UNAVAILABLE');
    const presence = stage.querySelector('.damocles-presence__button');
    expect(presence?.getAttribute('aria-pressed')).toBe('false');

    click(presence);
    expect(latest.listening).toBe(true);
    expect(stage.querySelector('.damocles-presence__button')?.getAttribute('aria-pressed')).toBe('true');
    expect(uncaughtErrors).toEqual([]);
  });

  it('recovers when the object is replaced with valid data', () => {
    const stage = mountStage();
    send(brokenDiagram);
    send(validDiagram);

    expect(stage.querySelector('[data-scene="architecture"]')).not.toBeNull();
    expect(stage.querySelector('.stage-unavailable')).toBeNull();
    expect(uncaughtErrors).toEqual([]);
  });
});

class FakeSocket {
  static latest: FakeSocket | null = null;
  readyState = 0;
  binaryType = 'blob';
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.latest = this;
  }

  send() {}

  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

describe('a display that fails outright', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    window.history.replaceState(null, '', '/?ws=ws://switchboard.test/ws');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('does not hang up the call', () => {
    const page = mount(<App />);
    const socket = FakeSocket.latest;
    expect(socket).not.toBeNull();

    // A conversation with no data throws in the stage itself, outside every
    // scene and object surface.
    send({ op: 'runtime_show', id: RUNTIME_CONVERSATION_ID, type: 'message', data: null });

    expect(uncaughtErrors).toEqual([]);
    expect(page.querySelector('.stage-unavailable')?.textContent).toBe('DISPLAY / UNAVAILABLE');
    expect(socket?.closed).toBe(false);
  });
});
