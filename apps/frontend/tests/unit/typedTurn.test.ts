import { describe, expect, it } from 'vitest';
import corpus from '../fixtures/typed-turns.json';
import { MAX_TYPED_TURN_CHARS as CAP, readTypedTurn } from '../../src/protocol';

// What the page sends for a draft, and what the service takes of it: the same
// cases run in apps/backend/tests/test_caller_input.rs.
describe('the typed turn the page reads from a draft', () => {
  for (const { draft, body } of corpus.cases) {
    it(`reads ${JSON.stringify(draft)} as ${JSON.stringify(body)}`, () => {
      const turn = readTypedTurn(draft);
      expect(turn.ok ? turn.body : null).toBe(body);
    });
  }

  it('refuses a lone surrogate, and only a lone one', () => {
    const verdicts = ['a\ud800', '\udc00b', '\udc00\ud800', 'ok', '\u{1F680}'].map((draft) => {
      const turn = readTypedTurn(draft);
      return turn.ok ? 'ok' : turn.why;
    });
    expect(verdicts).toEqual(['broken', 'broken', 'broken', 'ok', 'ok']);
  });

  it('checks blank, then broken, then too long', () => {
    expect([' \u0085 ', '\ud800', 'x'.repeat(CAP + 1) + '\ud800', 'x'.repeat(CAP + 1)].map((draft) => {
      const turn = readTypedTurn(draft);
      return turn.ok ? 'ok' : turn.why;
    })).toEqual(['blank', 'broken', 'broken', 'too_long']);
  });

  // A regex trim backtracks over this for 27 s; the test's own timeout is the budget.
  it('reads a long run of whitespace inside a paste at once', () => {
    const turn = readTypedTurn('a' + ' '.repeat(200_000) + 'b');
    expect(turn.ok ? 'ok' : turn.why).toBe('too_long');
  });
});
