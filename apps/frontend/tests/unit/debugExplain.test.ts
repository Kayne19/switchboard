// Plain-word routing explanations on the debug page.
import { describe, expect, it } from 'vitest';
import { answerRows, decisionSummary, preview } from '../../src/debug/explain';

describe('debug explanations', () => {
  const config = { jev_for_current_agent_lower: 0.3, jev_for_current_agent_upper: 0.7, jev_action_threshold: 0.6 };

  it('turns Jev answers into bars with the thresholds that apply', () => {
    const rows = answerRows(
      {
        action: { choice: 'continue', probabilities: { continue: 0.48, go_to_project: 0.41 }, confidence: 0.48 },
        for_current_agent: { noul: 0.52 },
        target: { selected: 'alpha', confidence: 0.97 },
      },
      config,
    );
    expect(rows[0]).toMatchObject({ question: 'action', selected: 'continue', confidence: 0.48, markers: [{ value: 0.6 }] });
    expect(rows[0].bars.map((bar) => [bar.label, bar.selected])).toEqual([
      ['continue', true],
      ['go_to_project', false],
    ]);
    expect(rows[0].verdict).toMatch(/< action threshold 0.60: unsure/);
    expect(rows[1].verdict).toMatch(/between 0.30 and 0.70/);
    expect(rows[2]).toMatchObject({ selected: 'alpha', confidence: 0.97 });
    expect(answerRows('nope', config)).toEqual([]);
  });

  it('summarises utility decisions and clipped values', () => {
    expect(
      decisionSummary({
        kind: 'dispatch_parts',
        parts: [
          { project: 'a', text: 'x' },
          { project: 'b', text: 'y' },
        ],
      }),
    ).toBe('dispatch 2 parts → a, b');
    expect(decisionSummary({ kind: 'second_opinion', target: 'a', mode: 'fresh', confident: false })).toBe('second opinion → a (fresh, not confident)');
    expect(decisionSummary({ kind: 'none' })).toBe('no decision');
    expect(preview({ clipped: true, bytes: 9000, preview: '{"a":' })).toBe('[clipped 9000 B] {"a":');
  });
});
