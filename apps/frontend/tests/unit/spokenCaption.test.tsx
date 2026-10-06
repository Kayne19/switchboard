// @vitest-environment jsdom
// The live response shows the line being heard (#112). A spoken line's text
// reaches the page before its audio has played -- while earlier lines are
// still playing -- and the page waits for its audio's turn before showing it.
// These drive the real runtime adapter with the frames the backend sends.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerState, MessageData } from '../../src/controller/types';
import { RUNTIME_CONVERSATION_ID } from '../../src/controller/types';
import { RuntimeIntegration } from '../../src/integration/runtime';
import { helloAck, statusMessage, transcriptEntry } from '../fixtures/serverMessages';

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

  screenStates(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === 'string')
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame.type === 'screen_state');
  }
}

let host: HTMLDivElement;
let root: Root;
let socket: FakeSocket;
let latest: ControllerState;
// The audio element the page plays through, once it has played anything.
let player: HTMLMediaElement | null;
let playerEnded: boolean;

function StateRecorder() {
  latest = useController().state;
  return null;
}

async function receive(message: object) {
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  });
}

// One utterance of audio, start to finish.
async function receiveUtterance(sequence: number) {
  await receive({ type: 'audio_start', generation: 1, sequence, mime: 'audio/mpeg', format: 'mp3' });
  await act(async () => {
    socket.onmessage?.({ data: new TextEncoder().encode('mp3').buffer } as MessageEvent);
  });
  await receive({ type: 'audio_done', generation: 1, sequence, done: true });
}

// The utterance playing now comes to its end.
async function finishPlaying() {
  await act(async () => {
    playerEnded = true;
    player!.dispatchEvent(new Event('ended'));
    playerEnded = false;
  });
}

function spoken(text: string, sequence?: number) {
  return {
    type: 'spoken',
    entry: transcriptEntry({ role: 'agent', text, route: 'alpha', voiced: true }),
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function liveText(): string | undefined {
  const message = latest.runtimeObjects[RUNTIME_CONVERSATION_ID]?.data as MessageData | undefined;
  return message?.segments[0]?.text;
}

function loggedTexts(): string[] {
  const message = latest.runtimeObjects[RUNTIME_CONVERSATION_ID]?.data as MessageData | undefined;
  return message?.lines?.map((line) => line.text) ?? [];
}

function transcriptTexts(): string[] {
  const message = latest.runtimeObjects[RUNTIME_CONVERSATION_ID]?.data as MessageData | undefined;
  return message?.transcript?.map((line) => line.text) ?? [];
}

beforeEach(async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  player = null;
  playerEnded = false;
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    player = this;
    return Promise.resolve();
  });
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => 'blob:utterance');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'ended', 'get').mockImplementation(() => playerEnded);
  window.history.replaceState(null, '', '/?ws=ws://switchboard.test/ws');
  host = document.createElement('div');
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ControllerProvider>
        <RuntimeIntegration />
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
  await receive(statusMessage({ route: 'alpha', label: 'alpha', projects: ['alpha'] }));
  await receive({ type: 'history', entries: [] });
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the live response follows the audio (#112)', () => {
  it('shows each speak() line when its audio starts, not when its text arrives', async () => {
    await receiveUtterance(1);
    await receive(spoken('First line.', 1));
    expect(liveText()).toBe('First line.');

    // The next two lines are synthesized while the first still plays.
    await receiveUtterance(2);
    await receive(spoken('Second line.', 2));
    await receiveUtterance(3);
    await receive(spoken('Third line.', 3));
    expect(liveText(), 'the first line is still the one being heard').toBe('First line.');
    expect(latest.runtimeSpeech?.text).toBe('First line.');
    // The transcript has every line as soon as it arrives.
    expect(transcriptTexts()).toEqual(['First line.', 'Second line.', 'Third line.']);

    await finishPlaying();
    expect(liveText()).toBe('Second line.');
    await finishPlaying();
    expect(liveText()).toBe('Third line.');
    expect(latest.runtimeSpeech?.text).toBe('Third line.');
  });

  it('shows a voiced reply when its audio starts, after the reply arrives', async () => {
    await receive({ type: 'reply', text: 'Putting you through.', route: 'operator', voiced: true, sequence: 4 });
    expect(transcriptTexts()).toEqual(['Putting you through.']);
    expect(liveText()).toBeUndefined();

    await receiveUtterance(4);
    expect(liveText()).toBe('Putting you through.');
  });

  it('shows a line that has no audio at once', async () => {
    await receive(spoken('You hung up the line to alpha.'));
    expect(liveText()).toBe('You hung up the line to alpha.');
  });

  it('keeps a written reply off the live response while a spoken line waits', async () => {
    await receiveUtterance(1);
    await receive(spoken('Running the tests.', 1));
    await receiveUtterance(2);
    await receive(spoken('They pass.', 2));
    await receive({ type: 'reply', text: 'Written summary.', route: 'alpha', voiced: false });
    expect(liveText()).toBe('Running the tests.');
    await finishPlaying();
    expect(liveText()).toBe('They pass.');
  });

  it('shows the waiting lines when a new leg cuts their audio off', async () => {
    await receiveUtterance(1);
    await receive(spoken('First line.', 1));
    await receiveUtterance(2);
    await receive(spoken('Cut off.', 2));
    expect(liveText()).toBe('First line.');

    // A rescue: a new epoch the page did not see coming retires the audio.
    await receive({ type: 'epoch', generation: 2 });
    expect(liveText()).toBe('Cut off.');
  });
});

describe('the live response keeps a log of what was said (#113)', () => {
  it('adds each line when its audio starts, and keeps the earlier ones', async () => {
    await receiveUtterance(1);
    await receive(spoken('First line.', 1));
    await receiveUtterance(2);
    await receive(spoken('Second line.', 2));
    expect(loggedTexts()).toEqual(['First line.']);

    await finishPlaying();
    expect(loggedTexts()).toEqual(['First line.', 'Second line.']);
    expect(liveText()).toBe('Second line.');
  });

  it('keeps written replies out of it', async () => {
    await receive(spoken('Running the tests.'));
    await receive({ type: 'reply', text: 'Written summary.', route: 'alpha', voiced: false });
    expect(loggedTexts()).toEqual(['Running the tests.']);
    expect(transcriptTexts()).toEqual(['Running the tests.', 'Written summary.']);
  });

  it('puts a line whose text came late before the line heard after it', async () => {
    // The second utterance is already playing when the first line's text
    // arrives: it goes before it, and the live response stays on the second.
    await receiveUtterance(1);
    await receiveUtterance(2);
    await finishPlaying();
    await receive(spoken('Done.', 2));
    await receive(spoken('A long first line.', 1));
    expect(loggedTexts()).toEqual(['A long first line.', 'Done.']);
    expect(liveText()).toBe('Done.');
  });

  it("starts again from the voiced lines a reconnect's history holds", async () => {
    await receive(spoken('Before the reconnect.'));
    await receive({
      type: 'history',
      entries: [
        transcriptEntry({ role: 'caller', text: 'Status?', id: 'c1' }),
        transcriptEntry({ role: 'agent', text: 'Spoken earlier.', voiced: true }),
        transcriptEntry({ role: 'agent', text: 'Written only.', voiced: false }),
        transcriptEntry({ role: 'agent', text: 'Spoken last.', voiced: true }),
      ],
    });
    expect(loggedTexts()).toEqual(['Spoken earlier.', 'Spoken last.']);
    expect(liveText()).toBe('Spoken last.');
  });
});
