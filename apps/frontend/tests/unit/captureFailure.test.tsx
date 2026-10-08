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
import type { ControllerState } from '../../src/controller/types';
import { RuntimeIntegration } from '../../src/integration/runtime';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { helloAck, statusMessage } from '../fixtures/serverMessages';

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

function StateRecorder() {
  latest = useController().state;
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
