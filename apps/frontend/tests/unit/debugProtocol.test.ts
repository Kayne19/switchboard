// The debug page's protocol parser, held to the shared fixture
// (`tests/fixtures/debug-events.json`) that the Rust `DebugEvent` serializes to.
import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/debug-events.json';
import { EVENT_FIELDS, parseDebugEvent, parseDebugFrame } from '../../src/debug/protocol';

const config = fixture.snapshot.config;

describe('debug protocol parser', () => {
  it('admits every fixture event and the fixture snapshot', () => {
    for (const { name, event: body } of fixture.events) {
      const parsed = parseDebugEvent(body);
      expect(parsed, name).toEqual({ ok: true, value: body });
      expect(Object.keys(EVENT_FIELDS)).toContain(body.kind);
    }
    const parsed = parseDebugFrame(JSON.stringify(fixture.snapshot));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.skipped).toEqual([]);
      expect(parsed.value.frame).toMatchObject({
        type: 'snapshot',
        last_seq: fixture.snapshot.last_seq,
        config,
        events: fixture.snapshot.events,
        logs: fixture.snapshot.logs,
      });
    }
  });

  it('admits a live event frame with its kind and fields flattened', () => {
    const parsed = parseDebugFrame(JSON.stringify({ type: 'event', seq: 9, timestamp_ms: 5, ...fixture.events[0].event }));
    expect(parsed).toEqual({ ok: true, value: { frame: { type: 'event', seq: 9, timestamp_ms: 5, ...fixture.events[0].event }, skipped: [] } });
  });

  it('keeps the clipped mark on an event and a log', () => {
    const event = { type: 'event', seq: 9, timestamp_ms: 5, clipped: true, ...fixture.events[0].event };
    expect(parseDebugFrame(JSON.stringify(event))).toEqual({ ok: true, value: { frame: event, skipped: [] } });
    const log = { type: 'log', seq: 10, timestamp_ms: 6, level: 'INFO', target: 't', message: 'm…[clipped]', fields: {}, clipped: true };
    expect(parseDebugFrame(JSON.stringify(log))).toEqual({ ok: true, value: { frame: log, skipped: [] } });
  });

  it('rejects malformed frames gracefully instead of throwing', () => {
    const rejects = [
      'not json',
      '[]',
      JSON.stringify({ type: 'mystery', seq: 1 }),
      JSON.stringify({ type: 'event', seq: 1, timestamp_ms: 1, kind: 'routed', utterance_id: 'u' }),
      JSON.stringify({ type: 'event', seq: 'one', timestamp_ms: 1, kind: 'host_link', host: 'h', connected: true }),
      JSON.stringify({ type: 'event', seq: 1, timestamp_ms: 1, kind: 'host_link', host: 'h', connected: 'yes' }),
      JSON.stringify({ type: 'log', seq: 1, timestamp_ms: 1, level: 3, target: 't', message: 'm', fields: {} }),
      JSON.stringify({ type: 'snapshot', events: [], logs: [], agents: [], config: { jev_action_threshold: 0.6 } }),
    ];
    for (const frame of rejects) {
      const parsed = parseDebugFrame(frame);
      expect(parsed.ok, frame).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/\w/);
    }
  });

  it('keeps an event of an unknown kind raw, and skips bad snapshot entries', () => {
    const unknown = parseDebugFrame(JSON.stringify({ type: 'event', seq: 4, timestamp_ms: 2, kind: 'from_the_future', x: 1 }));
    expect(unknown).toEqual({
      ok: true,
      value: {
        frame: { type: 'unknown_event', seq: 4, timestamp_ms: 2, kind: 'from_the_future', raw: { seq: 4, timestamp_ms: 2, kind: 'from_the_future', x: 1 } },
        skipped: [],
      },
    });
    const parsed = parseDebugFrame({
      ...fixture.snapshot,
      last_seq: 12,
      events: [...fixture.snapshot.events, { seq: 3, timestamp_ms: 1, kind: 'routed' }, { seq: 4, timestamp_ms: 1, kind: 'novel' }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.frame.type === 'snapshot') {
      expect(parsed.value.frame.events).toHaveLength(1);
      expect(parsed.value.frame.unknown?.map((entry) => entry.kind)).toEqual(['novel']);
      expect(parsed.value.frame.last_seq).toBe(12);
      expect(parsed.value.skipped).toHaveLength(1);
    }
  });
});
