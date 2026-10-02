// The debug page's reducer, over the shared fixture and the scripted call
// fixture mode plays.
import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/debug-events.json';
import { fixtureFrames, scriptedCall } from '../../src/debug/demo';
import type { DebugEvent, DebugFrame } from '../../src/debug/protocol';
import { initialDebugState, reduceFrame, reduceFrames, routePath, type DebugState } from '../../src/debug/reducer';

const config = fixture.snapshot.config;
const snapshot = (events: DebugFrame[] = [], extra: Record<string, unknown> = {}): DebugFrame =>
  ({ type: 'snapshot', events: events.map(({ type: _type, ...rest }) => rest), logs: [], agents: [], config, ...extra }) as DebugFrame;
let nextSeq = 100;
const event = (body: DebugEvent, seq = (nextSeq += 1), timestamp_ms = 1_000 + seq): DebugFrame => ({ type: 'event', seq, timestamp_ms, ...body }) as DebugFrame;
const fold = (frames: DebugFrame[]): DebugState => reduceFrames(initialDebugState(), frames);
const fixtureEvent = (kind: string) => fixture.events.find((entry) => entry.event.kind === kind)!.event as Record<string, unknown>;

describe('debug reducer', () => {
  const played = fixtureFrames(fixture as Parameters<typeof fixtureFrames>[0]).map((entry) => entry.frame);

  it('folds the fixture into one complete route trace and its panes', () => {
    const fixtureOnly = played.slice(0, fixture.events.length);
    const state = fold(fixtureOnly);
    expect(state.config).toEqual(config);
    expect(state.logs).toHaveLength(1);
    const trace = state.traces['clip-42'];
    expect(trace.text).toBe('Please send me to alpha.');
    expect(trace.jevResponse?.latency_ms).toBe(83);
    expect(trace.decision?.rule).toBe('jev_action');
    expect(trace.branch?.branch).toBe('utility');
    expect(trace.utility).toHaveLength(1);
    expect(trace.utility[0].decision?.latency_ms).toBe(211);
    expect(trace.operatorTool?.target).toBe('alpha');
    expect(routePath(trace)).toMatchObject({
      stages: ['jev', 'utility', 'operator'],
      pending: false,
      destinations: [{ agent: 'alpha', from: 'utility', via: 'utility' }],
    });
    const kinds = state.panes.alpha.items.map((item) => item.type);
    expect(kinds).toEqual(expect.arrayContaining(['routed', 'input', 'text', 'tool', 'module', 'turn', 'speech', 'floor', 'rescue']));
    const tool = state.panes.alpha.items.find((item) => item.type === 'tool');
    expect(tool).toMatchObject({ tool: 'bash', status: 'ok', args: { command: 'cargo test' }, result: { exit_code: 0 } });
    const module = state.panes.alpha.items.find((item) => item.type === 'module');
    expect(module).toMatchObject({ name: 'speak', ok: true, detail: { status: 'delivered' } });
    const floor = state.floors[state.floorOrder[0]];
    expect(floor).toMatchObject({ agent: 'alpha', requested: true, rewrite: { rewritten: 'I have good news: the build passes.' }, released: { how: fixtureEvent('floor_released').how } });
    expect(floor.gates.map((gate) => gate.answer)).toEqual(['yes']);
    expect(state.hosts['builder-1'].connected).toBe(true);
    expect(state.turns[0]).toMatchObject({ agent: 'alpha', turnId: 'turn-8', endTs: expect.any(Number) });
    expect(state.paneOrder.slice(0, 3)).toEqual(['operator', 'utility', 'alpha']);
  });

  it('draws fan-out, split retry, operator hand-off, fallback, and pending routes', () => {
    const state = fold(played);
    const fanOut = routePath(state.traces['u-103']);
    expect(fanOut.stages).toEqual(['jev', 'utility']);
    expect(fanOut.destinations.map((destination) => [destination.agent, destination.from])).toEqual([
      ['alpha', 'utility'],
      ['beta', 'utility'],
    ]);
    expect(fanOut.segments.map((segment) => segment.label)).toEqual(['', 'utility']);
    const handOff = state.traces['u-104'];
    expect(handOff.utility.map((attempt) => attempt.attempt)).toEqual(['first', 'split_retry']);
    const handOffPath = routePath(handOff);
    expect(handOffPath.stages).toEqual(['jev', 'utility', 'operator']);
    expect(handOffPath.segments[2].label).toBe('second_opinion · unsure');
    expect(handOffPath.destinations).toMatchObject([{ agent: 'beta', from: 'operator', via: 'operator' }]);
    expect(state.traces['u-105'].decision).toMatchObject({ rule: 'jev_unavailable', decided_by: 'fallback' });
    expect(routePath(state.traces['u-105'])).toMatchObject({
      pending: false,
      stages: ['jev', 'utility'],
      segments: [{ label: 'timeout' }, { label: 'utility' }],
      destinations: [{ agent: 'alpha', from: 'utility', via: 'utility', label: 'utility · continue' }],
    });
    expect(routePath(state.traces['u-106'])).toMatchObject({
      stages: ['jev'],
      pending: false,
      destinations: [],
      ended: { branch: 'dropped_stale', label: 'dropped (stale generation)' },
    });
    expect(routePath(state.traces['u-107'])).toMatchObject({ stages: ['jev'], pending: true, destinations: [] });
    // The operator answered u-101 itself and the utility pane mirrors routing work.
    expect(routePath(state.traces['u-101']).destinations[0]).toMatchObject({ agent: 'operator' });
    expect(state.panes.utility.items.filter((item) => item.type === 'utility').length).toBeGreaterThanOrEqual(4);
    // The floor message went through two gate answers and a rewrite.
    const beta = state.floorOrder.map((id) => state.floors[id]).find((floor) => floor.agent === 'beta')!;
    expect(beta.gates.map((gate) => gate.answer)).toEqual(['no', 'yes']);
    expect(beta.jev.filter((record) => record.kind === 'jev_response')).toHaveLength(2);
    expect(beta.speech?.text).toBe(beta.rewrite?.rewritten);
    expect(state.missing).toEqual([]);
    expect(state.gaps).toBe(0);
  });

  it('never writes into a state it was given', () => {
    const before = fold(played.slice(0, 40));
    const copy = JSON.stringify(before);
    reduceFrames(before, played.slice(40));
    expect(JSON.stringify(before)).toBe(copy);
  });

  it('replaces the projection on a resync snapshot and keeps counting', () => {
    let state = fold([snapshot(), event({ kind: 'caller_utterance', utterance_id: 'old', text: 'old', talking_to: 'operator' }, 5)]);
    expect(state.traceOrder).toEqual(['old']);
    expect(state.resyncs).toBe(0);
    const fresh = event({ kind: 'caller_utterance', utterance_id: 'new', text: 'new', talking_to: 'operator' }, 50);
    state = reduceFrame(state, snapshot([fresh]));
    expect(state.traceOrder).toEqual(['new']);
    expect(state.resyncs).toBe(1);
    expect(state.maxSeq).toBe(50);
    // A live frame the snapshot already covered is a duplicate.
    expect(reduceFrame(state, fresh).events).toHaveLength(1);
  });

  it('honours last_seq, drops duplicates, and remembers gaps until filled', () => {
    let state = fold([snapshot([], { last_seq: 10 })]);
    state = reduceFrame(state, event({ kind: 'host_link', host: 'h', connected: true }, 9));
    expect(state.events).toHaveLength(0);
    state = reduceFrame(state, event({ kind: 'host_link', host: 'h', connected: true }, 11));
    state = reduceFrame(state, event({ kind: 'host_link', host: 'h', connected: false }, 14));
    expect(state.missing).toEqual([12, 13]);
    expect(state.gaps).toBe(1);
    state = reduceFrame(state, { type: 'log', seq: 12, timestamp_ms: 1, level: 'INFO', target: 't', message: 'late', fields: {} });
    expect(state.missing).toEqual([13]);
    expect(state.logs).toHaveLength(1);
    state = reduceFrame(state, event({ kind: 'host_link', host: 'h', connected: true }, 14));
    expect(state.events).toHaveLength(2);
    state = reduceFrame(state, snapshot([]));
    expect(state.missing).toEqual([]);
  });

  it('appends streamed pieces and lets a final reply replace them', () => {
    const turn = 'operator-1';
    let state = fold([
      snapshot(),
      event({ kind: 'agent_text', agent: 'operator', turn_id: turn, text: 'Hel', final: false }),
      event({ kind: 'agent_text', agent: 'operator', turn_id: turn, text: 'lo', final: false }),
    ]);
    const text = () => state.panes.operator.items.filter((item) => item.type === 'text');
    expect(text()).toMatchObject([{ text: 'Hello', final: false, parts: 2 }]);
    state = reduceFrame(state, event({ kind: 'agent_text', agent: 'operator', turn_id: turn, text: 'Hello there.', final: true }));
    expect(text()).toMatchObject([{ text: 'Hello there.', final: true }]);
    // Pieces split by a tool call are kept, dimmed, beside the final reply.
    state = fold([
      snapshot(),
      event({ kind: 'agent_text', agent: 'alpha', turn_id: 't', text: 'Looking.', final: false }),
      event({ kind: 'tool_start', agent: 'alpha', tool: 'read' }),
      event({ kind: 'tool_end', agent: 'alpha', tool: 'read', error: 'no such file' }),
      event({ kind: 'agent_text', agent: 'alpha', turn_id: 't', text: 'Found it.', final: false }),
      event({ kind: 'agent_text', agent: 'alpha', turn_id: 't', text: 'Looking. Found it.', final: true }),
    ]);
    const items = state.panes.alpha.items;
    expect(items.map((item) => item.type)).toEqual(['text', 'tool', 'text', 'text']);
    expect(items[1]).toMatchObject({ status: 'error', error: 'no such file' });
    expect(items.filter((item) => item.type === 'text' && item.superseded)).toHaveLength(2);
  });

  it('marks pane items whose record the service clipped', () => {
    const clipped = (frame: DebugFrame): DebugFrame => ({ ...frame, clipped: true }) as DebugFrame;
    const state = fold([
      clipped(event({ kind: 'agent_input', agent: 'beta', text: 'long prompt…[clipped]', source: 'caller' })),
      event({ kind: 'agent_text', agent: 'beta', turn_id: 'b-1', text: 'short', final: false }),
      clipped(event({ kind: 'agent_text', agent: 'beta', turn_id: 'b-1', text: 'more…[clipped]', final: false })),
      event({ kind: 'tool_start', agent: 'beta', call_id: 'c-1', tool: 'bash', args: { command: 'ls' } }),
      clipped(event({ kind: 'tool_end', agent: 'beta', call_id: 'c-1', tool: 'bash', result: { out: 'x…[clipped]' } })),
      event({ kind: 'module_call', agent: 'beta', call_id: 'm-1', name: 'speak', args: { text: 'hi' } }),
    ]);
    const items = state.panes.beta.items;
    expect(items.find((item) => item.type === 'input')).toMatchObject({ clipped: true });
    expect(items.find((item) => item.type === 'text')).toMatchObject({ clipped: true, parts: 2 });
    expect(items.find((item) => item.type === 'tool')).toMatchObject({ clipped: true, status: 'ok' });
    expect(items.find((item) => item.type === 'module')).not.toHaveProperty('clipped', true);
  });

  it('keys floor messages by floor_id when present', () => {
    const state = fold([
      snapshot(),
      event({ kind: 'floor_request', agent: 'a', message: 'one', floor_id: 'f1' }),
      event({ kind: 'floor_request', agent: 'a', message: 'two', floor_id: 'f2' }),
      event({ kind: 'jev_response', utterance_id: 'gm', purpose: 'good_moment', latency_ms: 3, outcome: 'ok', answers: {}, floor_id: 'f1' }),
      event({ kind: 'floor_gate', agent: 'a', answer: 'yes', latency_ms: 3, floor_id: 'f1' }),
      event({ kind: 'floor_released', agent: 'a', how: 'spoken', floor_id: 'f1' }),
    ]);
    expect(state.floorOrder).toEqual(['f1', 'f2']);
    expect(state.floors.f1).toMatchObject({ message: 'one', released: { how: 'spoken' } });
    expect(state.floors.f1.jev).toHaveLength(1);
    expect(state.floors.f2.released).toBeUndefined();
  });

  it('records call boundaries and unknown kinds without projecting them', () => {
    const state = fold([
      snapshot(),
      event({ kind: 'call_boundary', phase: 'started', call_id: 'c1' }),
      { type: 'unknown_event', seq: (nextSeq += 1), timestamp_ms: 1, kind: 'novel', raw: {} },
      event({ kind: 'call_boundary', phase: 'ended', call_id: 'c1', reason: 'hangup' }),
    ]);
    expect(state.calls).toEqual([{ callId: 'c1', startTs: expect.any(Number), endTs: expect.any(Number), reason: 'hangup' }]);
    expect(state.unknown).toHaveLength(1);
    expect(state.callerLane.map((item) => item.type)).toEqual(['call', 'call']);
  });

  it('folds a few thousand events quickly and stays bounded', () => {
    const frames: DebugFrame[] = [snapshot([], { last_seq: 0 })];
    let seq = 0;
    const call = scriptedCall(0, 0).map((entry) => entry.frame);
    for (let round = 0; round < 60; round += 1) {
      for (const frame of call) {
        seq += 1;
        const copy = { ...frame, seq } as DebugFrame & { utterance_id?: string };
        if (copy.utterance_id !== undefined) copy.utterance_id = `${copy.utterance_id}-${round}`;
        frames.push(copy);
      }
    }
    expect(frames.length).toBeGreaterThan(6000);
    const started = performance.now();
    let state = initialDebugState();
    for (let index = 0; index < frames.length; index += 25) state = reduceFrames(state, frames.slice(index, index + 25));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(state.events.length).toBeLessThanOrEqual(4400);
    expect(state.traceOrder.length).toBeLessThanOrEqual(660);
    expect(Object.keys(state.traces)).toHaveLength(state.traceOrder.length);
    // A snapshot of the same thousands folds in one pass.
    const records = frames.slice(1).filter((frame) => frame.type === 'event');
    const snapStarted = performance.now();
    fold([snapshot(records.slice(-4000))]);
    expect(performance.now() - snapStarted).toBeLessThan(1500);
  });

  it('ends a dropped or failed trace instead of leaving it routing', () => {
    const utterance = (id: string): DebugEvent => ({ kind: 'caller_utterance', utterance_id: id, text: 'hello', talking_to: 'operator' });
    const branch = (id: string, name: string): DebugEvent => ({ kind: 'pbx_branch', utterance_id: id, branch: name, reason: `${name} because` });
    const state = fold([
      snapshot(),
      event(utterance('d-1')),
      event(branch('d-1', 'dropped_stale')),
      event(utterance('d-2')),
      event(branch('d-2', 'operator')),
      event(branch('d-2', 'failed')),
      event(utterance('d-3')),
      event(branch('d-3', 'operator')),
      event(utterance('d-4')),
      event(branch('d-4', 'refused_unknown_target')),
      event({ kind: 'routed', utterance_id: 'd-4', to_agent: 'operator', text_part: 'hello', mode: 'continue', via: 'pbx' }),
    ]);
    expect(routePath(state.traces['d-1'])).toMatchObject({ pending: false, destinations: [], ended: { branch: 'dropped_stale', reason: 'dropped_stale because' } });
    expect(routePath(state.traces['d-2'])).toMatchObject({ pending: false, ended: { branch: 'failed', label: 'failed' } });
    expect(routePath(state.traces['d-3'])).toMatchObject({ pending: true, ended: undefined });
    expect(routePath(state.traces['d-4'])).toMatchObject({
      pending: false,
      ended: undefined,
      destinations: [{ agent: 'operator', label: 'refused_unknown_target · continue' }],
    });
  });

  it('links floor speech by floor_id and guesses only without it', () => {
    const floorEvents = (id: string | undefined): DebugEvent[] => [
      { kind: 'floor_request', agent: 'alpha', message: 'The build passes.', floor_id: id },
      { kind: 'floor_gate', agent: 'alpha', answer: 'yes', latency_ms: 40, floor_id: id },
      { kind: 'floor_released', agent: 'alpha', how: 'gate_yes', floor_id: id },
    ];
    // A direct speak lands between the release and the floor's own speech.
    let state = fold([
      snapshot(),
      ...floorEvents('floor-1').map((body) => event(body)),
      event({ kind: 'speech', agent: 'alpha', text: 'unrelated direct speak', delivered: true }),
      event({ kind: 'speech', agent: 'alpha', text: 'Good news: the build passes.', delivered: true, floor_id: 'floor-1' }),
    ]);
    expect(state.floors['floor-1'].speech?.text).toBe('Good news: the build passes.');
    const loose = state.callerLane.filter((item) => item.type === 'speech');
    expect(loose.map((item) => item.type === 'speech' && item.text)).toEqual(['unrelated direct speak']);
    // Speech naming a floor the page no longer holds stays a loose line.
    state = reduceFrame(state, event({ kind: 'speech', agent: 'alpha', text: 'late', delivered: true, floor_id: 'floor-gone' }));
    expect(state.callerLane[state.callerLane.length - 1]).toMatchObject({ type: 'speech', text: 'late' });
    // An older service sends no ids: the first line after the release is it.
    state = fold([
      snapshot(),
      ...floorEvents(undefined).map((body) => event(body)),
      event({ kind: 'speech', agent: 'alpha', text: 'Good news: the build passes.', delivered: true }),
    ]);
    expect(state.floors[state.floorOrder[0]].speech?.text).toBe('Good news: the build passes.');
    // The fixture's speech names floor-7.
    expect(fixtureEvent('speech').floor_id).toBe('floor-7');
  });

  it('skips a refused live frame without opening a gap', () => {
    let state = fold([snapshot([], { last_seq: 5 })]);
    state = reduceFrames(state, [
      { type: 'skipped', seq: 6, error: 'speech.text is missing' },
      event({ kind: 'host_link', host: 'h', connected: true }, 7),
    ]);
    expect(state.missing).toEqual([]);
    expect(state.gaps).toBe(0);
    expect(state.rejected).toBe(1);
    expect(state.lastRejection).toBe('speech.text is missing');
    expect(state.events).toHaveLength(1);
    // A skip that fills a real hole closes it; a lost frame still opens one.
    state = reduceFrame(state, event({ kind: 'host_link', host: 'h', connected: false }, 10));
    expect(state.missing).toEqual([8, 9]);
    state = reduceFrame(state, { type: 'skipped', seq: 8, error: 'bad' });
    expect(state.missing).toEqual([9]);
    expect(state.rejected).toBe(2);
    expect(state.gaps).toBe(1);
  });
});
