import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/client-messages.json';
import { deriveScreenState } from '../../src/app/sceneModel';
import { createInitialState } from '../../src/controller/reducer';
import type { ScreenStateReport } from '../../src/controller/types';
import { screenStateMessage } from '../../src/protocol';

// The screen-state report is the one command whose fields come from outside
// protocol.ts, so its examples in the shared fixture are held to its type
// here. The service reads the same examples (apps/backend/tests/test_protocol.rs).

function example(name: string): unknown {
  const found = fixture.messages.find((entry) => entry.name === name);
  if (!found) throw new Error(`client-messages.json has no example ${name}`);
  return found.message;
}

describe('screen_state against the shared examples', () => {
  it('a page with nothing on its stage sends the empty-stage example', () => {
    const report = deriveScreenState(createInitialState(), 4);
    expect(JSON.parse(screenStateMessage(report))).toEqual(example('screen_state_empty_stage'));
  });

  it('a report with every field, optional ones included, sends the full example', () => {
    // `Required` makes this fail to compile when the report gains, loses, or
    // renames a field, until the example (and the service) follow.
    const report: Required<ScreenStateReport> = {
      view: 'visual',
      pinned: true,
      has_visual: true,
      visual_kind: 'chart',
      object_ids: ['loss', 'notes'],
      title: 'Training loss',
      stale: true,
      generation: 5,
      applied_seq: 12,
      rejected: { seq: 13, reason: 'unknown chart series' },
    };
    expect(JSON.parse(screenStateMessage(report))).toEqual(
      example('screen_state_applied_and_rejected'),
    );
  });
});
