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
import { helloAck, statusMessage, transcriptEntry } from '../fixtures/serverMessages';
import { stubResizeObserver } from './sceneHarness';
import { FakeSocket } from './fakeSocket';

// The page lays out by what it measures: the rail beside a visual, the room
// the line's error takes.
stubResizeObserver();

let host: HTMLDivElement;
let root: Root;
let socket: FakeSocket;
let latest: ControllerState;
let dispatch: (action: ControllerAction) => void;
let voice: ReturnType<typeof useController>['voiceRuntime'];

function StateRecorder() {
  const controller = useController();
  latest = controller.state;
  dispatch = controller.dispatch;
  voice = controller.voiceRuntime;
  return null;
}

async function receive(message: object) {
  await act(async () => {
    socket.receive(message);
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
  FakeSocket.install();
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
  socket = FakeSocket.latest();
  await act(async () => {
    socket.open();
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

/** The line's error as the scene on the stage draws it, tag and text; null while none is drawn. */
const drawnError = () => [...host.querySelectorAll('[data-scene]')].at(-1)?.querySelector('.channel-stack__error') ?? null;
const lineError = () => drawnError()?.textContent ?? null;

describe('a capture failure the caller can read', () => {
  it('says the page needs https when the browser offers no microphone', async () => {
    expect(navigator.mediaDevices, 'this page is not a secure origin').toBe(undefined);
    await tapDamocles();
    expect(lineError(), 'on the idle page, where the caller tapped').toMatch(/^LINE \/ ERROR.*https/);
    expect(latest.listening, 'and nothing is recording').toBe(false);
  });

  it('says it once, however many times the state is published', async () => {
    await tapDamocles();
    const drawn = drawnError();
    expect(drawn, 'the failure is drawn').not.toBe(null);
    await tapDamocles();
    expect(drawnError(), 'the same error, not drawn again').toBe(drawn);
    expect(lineError()).toMatch(/^LINE \/ ERROR.*https/);
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
    expect(lineError(), 'as an error of the line').toMatch(/^LINE \/ ERROR.*The model refused/);
    expect(cards(), 'not as an explanation in the rail').toEqual([]);

    await receive({ type: 'thinking', route: 'operator', waiting: 0 });
    expect(lineError(), 'a turn under way is not an error: the error is cleared').toBe(null);

    await receive({ type: 'reply', text: 'Here is what is new.', route: 'operator', voiced: false });
    expect(lineError(), 'nor is the idle line').toBe(null);
    expect(cards()).toEqual([]);
    expect(host.textContent).not.toContain(IDLE_TEXT);
    expect(host.textContent).not.toMatch(/is listening|is working/);
  });

  it('draws a server error said twice as the runtime says it', async () => {
    await receive({ type: 'error', message: 'The model refused.' });
    await receive({ type: 'error', message: 'The model refused.' });
    expect(lineError()).toBe('LINE / ERRORError: The model refused.');
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
    expect(lineError(), 'the failure is drawn').toMatch(/https/);

    await receive({ type: 'thinking', route: 'operator', waiting: 0 });
    await receive({ type: 'reply', text: 'Here is what is new.', route: 'operator', voiced: false });
    expect(lineError(), 'the microphone has not said it is over').toMatch(/^LINE \/ ERROR.*https/);
    expect(cards()).toEqual([]);
    expect(host.textContent).not.toContain(IDLE_TEXT);
    expect(host.textContent).not.toMatch(/is listening|is working/);
  });
});

describe('an error leaves with the leg it was about', () => {
  async function settle() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  }

  async function refusedPick() {
    await receive(statusMessage({ route: 'alpha', label: 'alpha', projects: ['alpha'], model: 'small' }));
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await act(async () => {
      voice!.line.selectModel('big');
      await settle();
    });
  }

  const serverError = () => receive({ type: 'error', message: 'The project agent crashed.' });

  async function backWithTheOperator() {
    await receive({ type: 'epoch', generation: 1 });
    await receive(statusMessage({ route: 'operator', label: 'operator', projects: ['alpha'] }));
  }

  async function rescued() {
    await receive({ type: 'candidate_cleared', route: 'alpha', generation: 2, reason: 'rescued' });
    await receive({ type: 'epoch', generation: 2 });
    await receive(statusMessage({ route: 'operator', label: 'operator', projects: ['alpha'] }));
  }

  it.each([
    ['a refused pick, once the caller is back with the operator', refusedPick, backWithTheOperator],
    ['a server error, once the leg is rescued', serverError, rescued],
  ])('%s', async (_name, fail, end) => {
    await fail();
    expect(lineError(), 'drawn while the leg lasts').not.toBe(null);
    await end();
    expect(lineError(), 'gone with the leg').toBe(null);
  });

  it('keeps a refused microphone through a hangup', async () => {
    await tapDamocles();
    await receive({ type: 'epoch', generation: 2 });
    await receive({ type: 'epoch', generation: 2 });
    await receive(statusMessage({ route: 'operator', label: 'operator', projects: ['alpha'] }));
    await receive({
      type: 'spoken',
      entry: transcriptEntry({ role: 'agent', text: 'Call ended. You are back with the operator.', id: 'hangup-1', voiced: true }),
    });
    expect(lineError(), 'the device is still refused').toMatch(/^LINE \/ ERROR.*https/);
  });
});
