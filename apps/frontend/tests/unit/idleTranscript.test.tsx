// @vitest-environment jsdom
// The idle stage keeps a voice-free way onto the line: the transcript toggle
// sits where it sits on the conversation page, out of sight until the pointer
// reaches the bottom of the stage, and opens the history drawer with its
// input ready to type into. The reveal itself is CSS (hover, focus-visible,
// hover: none) and is proven in tests/visual/idle-transcript.spec.ts; these
// cover the markup, the opener, and the typed turn's round trip.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { sceneKind } from '../../src/app/sceneModel';
import { ControllerProvider, useController } from '../../src/controller/context';
import { RUNTIME_CONVERSATION_ID } from '../../src/controller/types';
import { helloAck } from '../fixtures/serverMessages';

type Controller = ReturnType<typeof useController>;

class FakeSocket {
  static latest: FakeSocket | null = null;
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.latest = this;
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === 'string')
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

let host: HTMLDivElement;
let root: Root;
let controller: Controller;
let sentTexts: string[];

function Probe() {
  controller = useController();
  return null;
}

// Stands in for the call runtime: the drawer's input is live only while a
// runtime is registered, as it is on a real call.
function FakeVoiceRuntime() {
  const { registerVoiceRuntime } = useController();
  useEffect(() => {
    registerVoiceRuntime({
      toggleTurn: () => {},
      sendText: (text) => {
        sentTexts.push(text);
        return true;
      },
    });
    return () => registerVoiceRuntime(null);
  }, [registerVoiceRuntime]);
  return null;
}

function render(tree: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ControllerProvider>{tree}<Probe /></ControllerProvider>));
}

function stage(): HTMLElement {
  return host.querySelector<HTMLElement>('main.stage')!;
}

function drawer(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[role="dialog"][aria-label="Conversation history"]');
}

function input(): HTMLInputElement {
  return drawer()!.querySelector<HTMLInputElement>('input[aria-label="Conversation input"]')!;
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function type(field: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
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
  sentTexts = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the transcript toggle on the idle stage', () => {
  it('sits in a band along the bottom of the idle stage, in the tab order', () => {
    render(<SceneRenderer />);
    expect(stage().dataset.sceneKind).toBe('idle');

    const band = host.querySelector('.scene--idle > .transcript-reveal');
    expect(band).not.toBeNull();
    const toggle = band!.querySelector<HTMLButtonElement>('button.transcript-toggle');
    expect(toggle?.textContent).toBe('TRANSCRIPT HIDDEN');
    expect(toggle!.disabled).toBe(false);
    expect(toggle!.tabIndex).toBe(0);
    expect(toggle!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(toggle!.closest('[aria-hidden="true"], [inert]')).toBeNull();
    // The band is its own element beside the presence, never around it, so
    // it cannot swallow the glyph's clicks.
    expect(band!.querySelector('[data-testid="damocles-presence"]')).toBeNull();
    expect(host.querySelector('.scene--idle [data-testid="damocles-presence"]')).not.toBeNull();
  });

  it('opens the history drawer over the idle stage with its input focused', () => {
    render(<><SceneRenderer /><FakeVoiceRuntime /></>);
    expect(drawer()).toBeNull();

    click(host.querySelector('.transcript-reveal .transcript-toggle')!);

    expect(drawer()).not.toBeNull();
    expect(stage().dataset.sceneKind).toBe('idle');
    expect(input().disabled).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it('closes the drawer from idle with RETURN / ESC', () => {
    render(<><SceneRenderer /><FakeVoiceRuntime /></>);
    click(host.querySelector('.transcript-reveal .transcript-toggle')!);
    const back = [...drawer()!.querySelectorAll('button')].find((button) => button.textContent === 'RETURN / ESC');

    click(back!);

    expect(controller.transcriptOpen).toBe(false);
  });

  it('focuses the input when the runtime connects after the drawer is already open', () => {
    function DelayedVoiceRuntime({ connected }: { connected: boolean }) {
      const { registerVoiceRuntime } = useController();
      useEffect(() => {
        if (!connected) return;
        registerVoiceRuntime({
          toggleTurn: () => {},
          sendText: () => true,
        });
        return () => registerVoiceRuntime(null);
      }, [connected, registerVoiceRuntime]);
      return null;
    }

    function TestHarness({ connected }: { connected: boolean }) {
      return (
        <>
          <SceneRenderer />
          <DelayedVoiceRuntime connected={connected} />
        </>
      );
    }

    render(<TestHarness connected={false} />);
    click(host.querySelector('.transcript-reveal .transcript-toggle')!);
    expect(drawer()).not.toBeNull();
    expect(input().disabled).toBe(true);
    expect(document.activeElement).not.toBe(input());

    act(() => root.render(<ControllerProvider><TestHarness connected={true} /><Probe /></ControllerProvider>));
    expect(input().disabled).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it('is the toggle the conversation scene shows at rest, without the band', () => {
    render(<><SceneRenderer /><FakeVoiceRuntime /></>);
    act(() => controller.loadFixture('conversation'));
    expect(stage().dataset.sceneKind).toBe('conversation');

    const toggle = host.querySelector<HTMLButtonElement>('.scene--conversation > button.transcript-toggle');
    expect(toggle?.textContent).toBe('TRANSCRIPT HIDDEN');
    expect(toggle!.className).toBe('transcript-toggle tech micro');
    // The idle scene may still be resolving out beside it; the band is its own.
    expect(host.querySelector('.scene--conversation .transcript-reveal')).toBeNull();

    click(toggle!);
    expect(drawer()).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it.each(['training', 'architecture', 'email', 'code'] as const)('never appears on the %s scene', (fixture) => {
    render(<SceneRenderer />);
    act(() => controller.loadFixture(fixture));
    const scene = host.querySelector('.scene--content');
    expect(scene).not.toBeNull();
    expect(scene!.querySelector('.transcript-reveal, .transcript-toggle')).toBeNull();
  });
});

describe('typing in the drawer opened from idle', () => {
  it('reaches none of the page shortcuts, and Escape still closes the drawer', () => {
    // Demo mode is where the page has single-key shortcuts: a digit loads a
    // scene and `l` toggles listening.
    window.history.replaceState(null, '', '/?scene=idle');
    render(<><App /><FakeVoiceRuntime /></>);
    expect(stage().dataset.sceneKind).toBe('idle');
    click(host.querySelector('.transcript-reveal .transcript-toggle')!);
    const field = input();
    expect(document.activeElement).toBe(field);

    for (const key of ['l', '2', ' ', 'c', 'j']) press(field, key);
    type(field, 'l2 cj');

    expect(controller.state.listening).toBe(false);
    expect(controller.fixture).toBe('idle');
    expect(stage().dataset.sceneKind).toBe('idle');
    expect(host.querySelector('.controller-panel--open, .ir-drawer--open')).toBeNull();
    expect(field.value).toBe('l2 cj');

    press(field, 'Escape');
    expect(controller.transcriptOpen).toBe(false);
  });
});

describe('the voice-free path from idle', () => {
  let socket: FakeSocket;

  async function receive(message: object) {
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    });
  }

  beforeEach(async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    // jsdom has no media playback; a new epoch resets the player.
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    window.history.replaceState(null, '', '/?ws=ws://switchboard.test/ws');
    render(<App />);
    socket = FakeSocket.latest!;
    await act(async () => {
      socket.readyState = 1;
      socket.onopen?.({} as Event);
    });
    await receive(helloAck());
    await receive({ type: 'epoch', generation: 4 });
    await receive({ type: 'history', entries: [] });
  });

  it('sends a typed turn, and its echo turns the stage to the conversation under the open drawer', async () => {
    expect(stage().dataset.sceneKind).toBe('idle');
    click(host.querySelector('.transcript-reveal .transcript-toggle')!);
    const field = input();
    expect(document.activeElement).toBe(field);

    type(field, 'What is on the line?');
    click(drawer()!.querySelector('button[type="submit"]')!);

    const typed = socket.frames().filter((frame) => frame.type === 'typed_turn');
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ generation: 4, text: 'What is on the line?' });
    expect(field.value).toBe('');
    // Nothing went out as speech.
    expect(socket.frames().some((frame) => String(frame.type).startsWith('stt_') || frame.type === 'clip')).toBe(false);

    // The backend echoes a typed turn as the caller's transcript line.
    await receive({ type: 'transcript', id: typed[0].id, text: 'What is on the line?' });

    expect(sceneKind(controller.state)).toBe('conversation');
    expect(stage().dataset.sceneKind).toBe('conversation');
    expect(controller.state.runtimeObjects[RUNTIME_CONVERSATION_ID]).toBeDefined();
    expect(drawer()).not.toBeNull();
    expect(drawer()!.querySelector('.transcript__body')!.textContent).toContain('What is on the line?');
    // The same field, still focused, so the caller keeps typing.
    expect(input()).toBe(field);
    expect(document.activeElement).toBe(field);
  });

  it('leaves focus where the caller moved it when the line drops and comes back', async () => {
    click(host.querySelector('.transcript-reveal .transcript-toggle')!);
    expect(document.activeElement).toBe(input());
    const back = [...drawer()!.querySelectorAll('button')].find((button) => button.textContent === 'RETURN / ESC')!;
    act(() => back.focus());
    expect(document.activeElement).toBe(back);

    // The runtime registers itself again on every connection change; the
    // field is live throughout, so it has no reason to take focus back.
    await act(async () => {
      socket.readyState = 3;
      socket.onclose?.({} as CloseEvent);
    });
    expect(drawer()).not.toBeNull();
    expect(input().disabled).toBe(false);
    expect(document.activeElement).toBe(back);
  });
});
