// Plain-word routing explanations on the debug page.
import { describe, expect, it } from 'vitest';
import { COLLAPSED_SOURCES } from '../../src/debug/AgentPane';
import { scriptedCall } from '../../src/debug/demo';
import { answerRows, BRANCHES, branchText, decisionSummary, preview, RULES, ruleText, TERMINAL_BRANCHES } from '../../src/debug/explain';

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

// The service's vocabularies, read from its sources so a new value fails here.
const backend = import.meta.glob('../../../backend/src/*.rs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const docs = import.meta.glob('../../../../docs/debug-page.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function source(name: string): string {
  const entry = Object.entries(backend).find(([path]) => path.endsWith(`/${name}`));
  if (!entry) throw new Error(`no ${name}`);
  return entry[1];
}

function emittedRules(): string[] {
  const router = source('router.rs');
  const start = router.indexOf('impl RouteRule');
  const body = router.slice(start, router.indexOf('\n}\n', start));
  return [...body.matchAll(/Self::\w+ => "([a-z_]+)"/g)].map((match) => match[1]);
}

function emittedBranches(): string[] {
  const found = new Set<string>();
  for (const text of Object.values(backend)) {
    for (const match of text.matchAll(/trace_branch\(\s*"([a-z_]+)"/g)) found.add(match[1]);
    for (const match of text.matchAll(/branch:\s*"([a-z_]+)"\.into\(\)/g)) found.add(match[1]);
    for (const match of text.matchAll(/trace_cut_short\(\s*[^,]+,\s*[^,]+,\s*"([a-z_]+)"/g)) found.add(match[1]);
  }
  return [...found].sort();
}

function emittedSources(): string[] {
  const found = new Set<string>();
  for (const text of Object.values(backend)) {
    for (const call of text.matchAll(/(?:prompt_as|publish_input|spawn_background_prompt)\(([^;{]*?)\)/g)) {
      for (const literal of call[1].matchAll(/"([a-z_]+)"/g)) found.add(literal[1]);
    }
  }
  const local = source('pi_client.rs');
  const start = local.indexOf('fn local_prompt_source');
  for (const match of local.slice(start, local.indexOf('\n}\n', start)).matchAll(/=> "([a-z_]+)"/g)) found.add(match[1]);
  return [...found].sort();
}

/** The backticked values after `field` is introduced in the doc's schema line for `kind`. */
function documented(kind: string, field: string): string[] {
  const doc = Object.values(docs)[0];
  const line = doc.split('\n').find((entry) => entry.startsWith(`- \`${kind}\``));
  if (!line) throw new Error(`no ${kind} line`);
  // The sentence that lists the values, without its parenthetical notes.
  const sentence = line
    .slice(line.indexOf(`\`${field}\` is`) + field.length + 2)
    .replace(/\([^)]*\)/g, '')
    .split(/\.\s/)[0];
  return [...sentence.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
}

describe('debug vocabulary', () => {
  it('explains every rule the router emits', () => {
    const rules = emittedRules();
    expect(rules).toEqual(expect.arrayContaining(['current_agent_unsure', 'action_below_threshold', 'jev_action']));
    expect(rules.filter((rule) => !(rule in RULES))).toEqual([]);
    expect(Object.keys(RULES).filter((rule) => !rules.includes(rule))).toEqual([]);
    for (const rule of rules) expect(ruleText(rule)).not.toMatch(/^Rule “/);
  });

  it('explains every PBX branch the service emits', () => {
    const branches = emittedBranches();
    expect(branches).toEqual(expect.arrayContaining(['multi_unresolved', 'dropped_stale', 'operator', 'failed', 'refused_unknown_target']));
    expect(branches.filter((branch) => !(branch in BRANCHES))).toEqual([]);
    for (const branch of branches) expect(branchText(branch)).not.toMatch(/^Branch “/);
    for (const branch of Object.keys(TERMINAL_BRANCHES)) expect(BRANCHES).toHaveProperty(branch);
  });

  it('explains every rule and branch the debug page doc lists', () => {
    const rules = documented('route_decision', 'rule');
    const branches = documented('pbx_branch', 'branch');
    expect([...rules].sort()).toEqual(emittedRules().sort());
    expect(branches).toEqual(expect.arrayContaining(['stop_confirmed', 'multi_unresolved', 'dropped_stale']));
    expect(rules.filter((rule) => !(rule in RULES))).toEqual([]);
    expect(branches.filter((branch) => !(branch in BRANCHES))).toEqual([]);
  });

  it('folds only input sources the service sends', () => {
    const sources = emittedSources();
    expect(sources).toEqual(expect.arrayContaining(['caller', 'steer', 'brief', 'intro', 'routing_request', 'floor_rewrite']));
    expect([...COLLAPSED_SOURCES].filter((name) => !sources.includes(name))).toEqual([]);
  });

  it('scripts fixture mode with values the service emits', () => {
    const rules = emittedRules();
    const branches = emittedBranches();
    const sources = emittedSources();
    const floor = source('floor.rs');
    const hows = [...floor.matchAll(/(?:trace_released\([^,]+,\s*|=> )"([a-z_]+)"/g)].map((match) => match[1]);
    expect(hows).toEqual(expect.arrayContaining(['gate_yes', 'quiet_after_hold', 'dropped_agent_gone']));
    for (const { frame } of scriptedCall(0, 0)) {
      if (frame.type !== 'event') continue;
      if (frame.kind === 'route_decision') expect(rules).toContain(frame.rule);
      if (frame.kind === 'route_decision') expect(['jev', 'fallback']).toContain(frame.decided_by);
      if (frame.kind === 'pbx_branch') expect(branches).toContain(frame.branch);
      if (frame.kind === 'agent_input') expect(sources).toContain(frame.source);
      if (frame.kind === 'floor_released') expect(hows).toContain(frame.how);
      if (frame.kind === 'jev_request' || frame.kind === 'jev_response') {
        expect(frame.purpose === 'route' ? frame.utterance_id : frame.floor_id).toBeTruthy();
        if (frame.purpose !== 'route') expect(frame.utterance_id).toBeUndefined();
      }
    }
  });
});
