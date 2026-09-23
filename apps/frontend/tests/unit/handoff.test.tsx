// @vitest-environment jsdom
// An operator-to-project handoff must not flash the idle page, and the new
// leg's first words or first drawing must survive it (issue #22). These drive
// the real runtime adapter with the frames the backend sends for a transfer.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sceneKind, type SceneKind } from '../../src/app/sceneModel';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerState, MessageData } from '../../src/controller/types';
import { RUNTIME_CONVERSATION_ID } from '../../src/controller/types';
import { RuntimeIntegration } from '../../src/integration/runtime';

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

const operatorStatus = {
  type: 'status',
  route: 'operator',
  label: 'Operator',
  projects: ['switchboard'],
  thinking: 'medium',
  levels: ['low', 'medium', 'high'],
};
const projectStatus = { ...operatorStatus, route: 'switchboard', label: 'switchboard' };

const diagram = {
  op: 'show',
  id: 'call-path',
  type: 'diagram',
  role: 'primary',
  data: {
    mode: 'graph',
    title: 'Call path',
    nodes: [
      { id: 'operator', label: 'OPERATOR' },
      { id: 'agent', label: 'AGENT', state: 'active' },
    ],
    edges: [{ from: 'operator', to: 'agent', label: 'patch' }],
  },
};

let host: HTMLDivElement;
let root: Root;
let socket: FakeSocket;
// Every scene the page rendered, with consecutive repeats collapsed.
let scenes: SceneKind[];
let latest: ControllerState;

function SceneRecorder() {
  const { state } = useController();
  latest = state;
  const kind = sceneKind(state);
  if (scenes[scenes.length - 1] !== kind) scenes.push(kind);
  return null;
}

async function receive(message: Record<string, unknown>) {
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  });
}

// The page holds each screen report until the last one is acknowledged;
// acknowledge until it has nothing newer to send.
async function settledReport() {
  for (let sent = -1; sent !== socket.screenStates().length; ) {
    sent = socket.screenStates().length;
    await receive({ type: 'screen_state_ack' });
  }
  return socket.screenStates().at(-1);
}

function conversation(): MessageData {
  return latest.runtimeObjects[RUNTIME_CONVERSATION_ID]?.data as MessageData;
}

// The operator leg as the caller leaves it: they asked to be put through and
// the operator answered, so the page is on the conversation.
async function callTheOperator() {
  await act(async () => {
    socket.readyState = 1;
    socket.onopen?.({} as Event);
  });
  await receive({ type: 'hello_ack', version: 1, stt_streaming: false, mse_mp3: false });
  await receive({ type: 'epoch', generation: 1 });
  await receive(operatorStatus);
  await receive({ type: 'history', entries: [] });
  expect(sceneKind(latest)).toBe('idle');

  await receive({ type: 'transcript', id: 'c1', text: 'Put me through to switchboard.' });
  await receive({
    type: 'spoken',
    entry: { id: 'a1', role: 'agent', text: 'Putting you through to switchboard.' },
  });
  expect(sceneKind(latest)).toBe('conversation');
  scenes = ['conversation'];
}

// What the backend sends once the incoming leg shows life: the candidate is
// adopted, the scene moves to the new leg, and its status follows.
async function adoptTheProjectLeg() {
  await receive({ type: 'candidate', route: 'switchboard', generation: 1 });
  await receive({ type: 'candidate_cleared', generation: 2 });
  await receive({ type: 'epoch', generation: 2 });
  await receive(projectStatus);
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  // jsdom has no media playback; a new epoch resets the player.
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?ws=ws://switchboard.test/ws');
  scenes = [];
  host = document.createElement('div');
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ControllerProvider>
        <RuntimeIntegration />
        <SceneRecorder />
      </ControllerProvider>,
    );
  });
  socket = FakeSocket.latest!;
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('operator-to-project handoff', () => {
  it('keeps the conversation up through the leg change and shows the first response', async () => {
    await callTheOperator();
    await adoptTheProjectLeg();

    // Relabelled under the new leg without leaving the conversation.
    expect(sceneKind(latest)).toBe('conversation');
    expect(conversation().context).toBe('PROJECT / SWITCHBOARD');
    expect(conversation().transcript?.map((line) => line.text)).toEqual([
      'Put me through to switchboard.',
      'Putting you through to switchboard.',
    ]);

    // The PBX settles the transfer: it restates the status, not the epoch.
    await receive(projectStatus);
    await receive({ type: 'reply', text: 'Switchboard here. What do you need?' });

    expect(conversation().segments[0].text).toBe('Switchboard here. What do you need?');
    expect(scenes).toEqual(['conversation']);
  });

  it('keeps the first drawing from the new leg on screen after the handoff', async () => {
    await callTheOperator();
    await adoptTheProjectLeg();

    await receive({ type: 'display', seq: 5, action: diagram });
    expect(sceneKind(latest)).toBe('architecture');

    await receive(projectStatus);
    await receive({ type: 'reply', text: 'That is the call path.' });

    expect(sceneKind(latest)).toBe('architecture');
    expect(latest.agentOrder).toEqual(['call-path']);
    expect(conversation().segments[0].text).toBe('That is the call path.');
    expect(scenes).toEqual(['conversation', 'architecture']);

    // The agent can confirm it: the page reports the drawing under the new
    // generation.
    expect(await settledReport()).toMatchObject({
      generation: 2,
      applied_seq: 5,
      object_ids: ['call-path'],
    });
  });

  it('drops what the old leg drew but not the conversation', async () => {
    await callTheOperator();
    await receive({
      type: 'display',
      seq: 1,
      action: { op: 'show', id: 'queue', type: 'metric', data: { label: 'QUEUE', value: '1' } },
    });
    expect(latest.agentOrder).toEqual(['queue']);

    await adoptTheProjectLeg();

    expect(latest.agentOrder).toEqual([]);
    expect(sceneKind(latest)).toBe('conversation');
    expect(scenes).not.toContain('idle');
  });

  it('clears the conversation when a reconnect finds the server has none', async () => {
    await callTheOperator();
    await receive({ type: 'epoch', generation: 1 });
    await receive(operatorStatus);
    await receive({ type: 'history', entries: [] });

    expect(latest.runtimeObjects[RUNTIME_CONVERSATION_ID]).toBeUndefined();
    expect(sceneKind(latest)).toBe('idle');
  });
});
