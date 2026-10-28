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

// The page lays out by what it measures: the rail beside a visual, the room
// the line's error takes.
stubResizeObserver();

let host: HTMLDivElement;
let root: Root;
let socket: FakeSocket;
let latest: ControllerState;
let dispatch: (action: ControllerAction) => void;
let voice: ReturnType<typeof useController>["voiceRuntime"];

function StateRecorder() {
  const controller = useController();
  latest = controller.state;
  dispatch = controller.dispatch;
  voice = controller.voiceRuntime;
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
  await receive(statusMessage({ route: 'alpha', label: 'alpha', projects: ['alpha'], model: 'small' }));
  await receive({ type: 'history', entries: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  window.history.replaceState(null, '', '/');
});

const drawn = () => [...host.querySelectorAll('[data-scene]')].at(-1)?.querySelector('.channel-stack__error')?.textContent ?? null;

describe('verify: a refused pick on a project leg', () => {
  it('stands at the corner after a return to the operator and normal turns', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await act(async () => { voice!.line.selectModel('big'); });
    await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
    expect(latest.lineError, 'the refused pick is the line error').toMatch(/That did not go through/);
    expect(drawn()).toMatch(/That did not go through/);
    // The project agent hands the caller back to the operator.
    await receive({ type: 'candidate', route: 'operator', generation: 1 });
    await receive(statusMessage({ route: 'operator', label: 'operator', projects: ['alpha'] }));
    await receive({ type: 'epoch', generation: 1 });
    // Normal turns on the operator leg.
    await receive({ type: 'thinking', route: 'operator', waiting: 0 });
    await receive({ type: 'reply', text: 'Welcome back.', route: 'operator', voiced: false });
    await receive({ type: 'thinking', route: 'operator', waiting: 0 });
    await receive({ type: 'reply', text: 'Anything else?', route: 'operator', voiced: false });
    console.log('scene:', [...host.querySelectorAll('[data-scene]')].at(-1)?.getAttribute('data-scene'), 'route:', voice!.line.route, 'lineError:', latest.lineError);
    expect(drawn(), 'still drawn on the operator leg').toMatch(/That did not go through/);
  });
});

describe('verify: a server error on the old leg', () => {
  it('stands on the new leg after an epoch', async () => {
    await receive({ type: 'error', message: 'The project agent crashed.' });
    expect(drawn()).toMatch(/The project agent crashed/);
    await receive({ type: 'candidate_cleared', route: 'alpha', generation: 1, reason: 'rescued' });
    await receive({ type: 'epoch', generation: 2 });
    await receive(statusMessage({ route: 'operator', label: 'operator', projects: ['alpha'] }));
    console.log('scene:', [...host.querySelectorAll('[data-scene]')].at(-1)?.getAttribute('data-scene'), 'lineError:', latest.lineError);
    expect(drawn(), 'the old leg\'s error on the new leg').toMatch(/The project agent crashed/);
    await receive({ type: 'thinking', route: 'operator', waiting: 0 });
    expect(drawn(), 'until the caller\'s next turn').toBe(null);
  });
});
