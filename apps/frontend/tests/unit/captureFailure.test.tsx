// @vitest-environment jsdom
// A capture failure reaches the caller's screen. The runtime reports "no
// microphone", "this browser cannot record audio" and a recorder error as
// status text with the error flag set; the page used to render neither field,
// so on a browser where capture fails (an iPad over plain http, where WebKit
// leaves `navigator.mediaDevices` undefined) tapping Damocles did nothing at
// all and said nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction, ControllerState } from '../../src/controller/types';
import { RuntimeIntegration } from '../../src/integration/runtime';
import { IDLE_TEXT } from '../../src/runtime/callRuntime';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { helloAck, statusMessage } from '../fixtures/serverMessages';
import { stubResizeObserver } from './sceneHarness';

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
}

let host: HTMLDivElement;
let root: Root;
let socket: FakeSocket;
let latest: ControllerState;
let dispatch: (action: ControllerAction) => void;

function StateRecorder() {
  const controller = useController();
  latest = controller.state;
  dispatch = controller.dispatch;
  return null;
}

async function receive(message: object) {
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  });
}

/** The caller taps Damocles, the call's one control. */
async function tapDamocles() {
  const button = host.querySelector<HTMLButtonElement>(
    '[data-testid="damocles-presence"] button',
  );
  expect(button, 'the presence is on screen with its control').not.toBe(null);
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // The capture attempt settles in a promise of its own.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  window.history.replaceState(null, '', '/?ws=ws://switchboard.test/ws');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ControllerProvider>
        <RuntimeIntegration />
        <SceneRenderer />
        <StateRecorder />
      </ControllerProvider>,
    );
  });
  socket = FakeSocket.latest!;
  await act(async () => {
    socket.readyState = 1;
    socket.onopen?.({} as Event);
  });
  await receive(helloAck());
  await receive({ type: 'epoch', generation: 1 });
  await receive(statusMessage({ route: 'operator', label: 'operator', projects: ['alpha'] }));
  await receive({ type: 'history', entries: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('a capture failure the caller can read', () => {
  it('says the page needs https when the browser offers no microphone', async () => {
    expect(navigator.mediaDevices, 'this page is not a secure origin').toBe(undefined);
    await tapDamocles();
    expect(latest.runtimeSpeech?.text).toMatch(/https/);
    expect(latest.listening, 'and nothing is recording').toBe(false);
  });

  it('says it once, however many times the state is published', async () => {
    await tapDamocles();
    const said = latest.runtimeSpeech?.text;
    const at = latest.runtimeSpeech?.at ?? null;
    await tapDamocles();
    expect(latest.runtimeSpeech?.text).toBe(said);
    expect(latest.runtimeSpeech?.at ?? null).toBe(at);
  });
});

// The runtime reports routine status too -- the idle line, a turn under way --
// and only an error is drawn. A routine status reported while an error stood
// used to keep the error flag, so the turn after a failure put "Operator is
// listening..." and then the idle line "Connected. Tap Talk and speak." on
// screen as Damocles's explanation, beside the visual, and left it there
// (#213). On an iPad the error is often blocked audio, so this was the
// card a caller saw there and not on the desktop.
describe('only an error reaches the screen, and only while it stands', () => {
  // The visual's rail lays itself out by what it measures.
  beforeEach(() => stubResizeObserver());
  /** The words of every card in the rail beside the visual, tag and text. */
  const cards = () => [...host.querySelectorAll('.annotation-card')].map((card) => card.textContent ?? '');

  it('draws the error as a line error, and the turn after it leaves no status card', async () => {
    await act(async () => {
      dispatch({
        op: 'show', id: 'news', type: 'table', role: 'primary',
        data: { title: 'WHAT IS NEW', columns: [{ label: 'CHANGE' }], rows: [['one']] },
      });
    });
    await receive({ type: 'error', message: 'The model refused.' });
    expect(latest.runtimeSpeech?.text, 'the failure is said').toMatch(/The model refused/);
    expect(cards(), 'as an error of the line, not an explanation').toEqual([expect.stringMatching(/^LINE \/ ERROR.*The model refused/)]);

    await receive({ type: 'thinking', route: 'operator', waiting: 0 });
    expect(latest.runtimeSpeech, 'a turn under way is not an error: the error is cleared').toBe(null);

    await receive({ type: 'reply', text: 'Here is what is new.', route: 'operator', voiced: false });
    expect(latest.runtimeSpeech, 'nor is the idle line').toBe(null);
    // The card leaves as every rail card does, through its exit.
    for (let waited = 0; cards().length > 0 && waited < 3000; waited += 100) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }
    expect(cards()).toEqual([]);
    expect(host.textContent).not.toContain(IDLE_TEXT);
    expect(host.textContent).not.toMatch(/is listening|is working/);
  });

  // Each source takes down only its own error (#354). A turn's status is the
  // turn's: it leaves a capture failure up, still as the error, and the
  // turn's own words are never drawn.
  it('keeps a capture failure up through the turn after it', async () => {
    await act(async () => {
      dispatch({
        op: 'show', id: 'news', type: 'table', role: 'primary',
        data: { title: 'WHAT IS NEW', columns: [{ label: 'CHANGE' }], rows: [['one']] },
      });
    });
    await tapDamocles();
    expect(latest.runtimeSpeech?.text, 'the failure is said').toMatch(/https/);

    await receive({ type: 'thinking', route: 'operator', waiting: 0 });
    await receive({ type: 'reply', text: 'Here is what is new.', route: 'operator', voiced: false });
    expect(latest.runtimeSpeech?.text, 'the microphone has not said it is over').toMatch(/https/);
    expect(cards()).toEqual([expect.stringMatching(/^LINE \/ ERROR.*https/)]);
    expect(host.textContent).not.toContain(IDLE_TEXT);
    expect(host.textContent).not.toMatch(/is listening|is working/);
  });
});
