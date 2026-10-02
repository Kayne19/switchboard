// Fixture mode (`?fixture=1`): the page without a live call. It plays the
// shared fixture (one example of every event kind) and then a scripted call
// that exercises each routing path: Jev straight through, a utility fan-out,
// a split retry handed to the operator's route tool, a Jev timeout, and a
// floor message travelling back to the caller.
import type { DebugConfig, DebugEvent, DebugFrame, DebugLog, JsonValue } from './protocol';
import { parseDebugFrame } from './protocol';
import type { Feed, FeedHandlers } from './connection';

export interface ScriptedFrame {
  frame: DebugFrame;
  /** Wait before this frame, in ms of playback time. */
  delay: number;
}

interface FixtureFile {
  events: { name: string; event: DebugEvent }[];
  snapshot: unknown;
}

const CONFIG: DebugConfig = { jev_for_current_agent_lower: 0.3, jev_for_current_agent_upper: 0.7, jev_action_threshold: 0.6 };

const choice = (selected: string, probabilities: Record<string, number>): JsonValue => ({
  type: 'choice',
  choice: selected,
  probabilities,
  confidence: probabilities[selected] ?? 0,
});
const noul = (value: number): JsonValue => ({ type: 'noul', noul: value });

function routeAnswers(
  action: string,
  actionP: Record<string, number>,
  current: number,
  target: string,
  targetP: Record<string, number>,
  fresh: string,
  multi: number,
): JsonValue {
  return {
    action: choice(action, actionP),
    for_current_agent: noul(current),
    target: choice(target, targetP),
    continue_or_fresh: choice(
      fresh,
      fresh === 'fresh' ? { fresh: 0.81, continue: 0.14, not_applicable: 0.05 } : { continue: 0.77, fresh: 0.18, not_applicable: 0.05 },
    ),
    multi_target: noul(multi),
  };
}

class Script {
  readonly frames: ScriptedFrame[] = [];
  seq: number;
  ts: number;

  constructor(seq: number, ts: number) {
    this.seq = seq;
    this.ts = ts;
  }

  event(event: DebugEvent, delay = 220): void {
    this.seq += 1;
    this.ts += Math.max(delay, 1);
    this.frames.push({ frame: { type: 'event', seq: this.seq, timestamp_ms: this.ts, ...event } as DebugFrame, delay });
  }

  log(level: string, target: string, message: string, fields: DebugLog['fields'] = {}, delay = 40): void {
    this.seq += 1;
    this.ts += delay;
    this.frames.push({ frame: { type: 'log', seq: this.seq, timestamp_ms: this.ts, level, target, message, fields }, delay });
  }
}

function jevState(said: string, route: string, extra: Record<string, JsonValue> = {}): JsonValue {
  return {
    caller_just_said: said,
    current_route: route,
    projects: [
      { id: 'alpha', title: 'switchboard', status: 'idle' },
      { id: 'beta', title: 'homelab', status: 'busy' },
    ],
    recent_turns: [
      { role: 'caller', text: 'Good morning.' },
      { role: 'operator', text: 'Morning. Who should I put you through to?' },
    ],
    ...extra,
  };
}

/** The scripted call, numbered on from `seq` and `ts`. */
export function scriptedCall(startSeq: number, startTs: number): ScriptedFrame[] {
  const s = new Script(startSeq, startTs);
  s.event({ kind: 'host_link', host: 'builder-1', connected: true }, 300);
  s.event({ kind: 'host_link', host: 'nas', connected: true }, 60);
  s.event(
    {
      kind: 'agents_state',
      agents: [
        { project: 'alpha', state: 'idle' },
        { project: 'beta', state: 'busy' },
      ],
    },
    60,
  );
  s.log('INFO', 'switchboard::api', 'call connected', { generation: 7 });

  // 1. Small talk: Jev keeps it with the operator, who answers.
  s.event({ kind: 'caller_utterance', utterance_id: 'u-101', text: 'Morning! Anything break overnight?', talking_to: 'operator' }, 500);
  s.event({ kind: 'jev_request', utterance_id: 'u-101', purpose: 'route', state: jevState('Morning! Anything break overnight?', 'operator') }, 30);
  s.event(
    {
      kind: 'jev_response',
      utterance_id: 'u-101',
      purpose: 'route',
      latency_ms: 74,
      outcome: 'ok',
      answers: routeAnswers(
        'general',
        { general: 0.88, status: 0.08, go_to_project: 0.04 },
        0.12,
        'none',
        { none: 0.9, alpha: 0.06, beta: 0.04 },
        'continue',
        0.03,
      ),
    },
    80,
  );
  s.event(
    {
      kind: 'route_decision',
      utterance_id: 'u-101',
      rule: 'jev_action',
      reason: 'Jev action confidence 0.880 met threshold',
      action: 'general',
      mode: 'continue',
      decided_by: 'jev',
    },
    10,
  );
  s.event({ kind: 'pbx_branch', utterance_id: 'u-101', branch: 'operator', reason: 'general conversation stays with the front desk' }, 10);
  s.event({ kind: 'operator_hop', utterance_id: 'u-101', text: 'Morning! Anything break overnight?', outcome: 'answered' }, 20);
  s.event({ kind: 'routed', utterance_id: 'u-101', to_agent: 'operator', text_part: 'Morning! Anything break overnight?', mode: 'continue', via: 'jev' }, 10);
  s.event({ kind: 'turn_start', agent: 'operator', turn_id: 'op-1', generation: 7 }, 20);
  s.event(
    {
      kind: 'agent_input',
      agent: 'operator',
      turn_id: 'op-1',
      text: 'Projects: alpha (switchboard, idle), beta (homelab, busy: nightly backup check).',
      source: 'call_state',
    },
    10,
  );
  s.event({ kind: 'agent_input', agent: 'operator', turn_id: 'op-1', text: 'Morning! Anything break overnight?', source: 'caller' }, 10);
  s.event({ kind: 'tool_start', agent: 'operator', call_id: 'op-c1', tool: 'status', args: { scope: 'all' } }, 150);
  s.event({ kind: 'tool_end', agent: 'operator', call_id: 'op-c1', tool: 'status', result: { alpha: 'idle', beta: 'busy', failing_ci: ['alpha#128'] } }, 260);
  s.event({ kind: 'agent_text', agent: 'operator', turn_id: 'op-1', text: 'Morning. One red build on ', final: false }, 180);
  s.event({ kind: 'agent_text', agent: 'operator', turn_id: 'op-1', text: 'switchboard overnight, ', final: false }, 120);
  s.event(
    {
      kind: 'agent_text',
      agent: 'operator',
      turn_id: 'op-1',
      text: 'Morning. One red build on switchboard overnight, and homelab is checking backups.',
      final: true,
    },
    140,
  );
  s.event(
    { kind: 'speech', agent: 'operator', text: 'Morning. One red build on switchboard overnight, and homelab is checking backups.', delivered: true },
    60,
  );
  s.event({ kind: 'turn_end', agent: 'operator', turn_id: 'op-1', generation: 7 }, 20);

  // 2. A clear transfer: Jev goes straight to alpha.
  s.event(
    { kind: 'caller_utterance', utterance_id: 'u-102', text: 'Put me through to switchboard, I want to see that failing test.', talking_to: 'operator' },
    900,
  );
  s.event(
    {
      kind: 'jev_request',
      utterance_id: 'u-102',
      purpose: 'route',
      state: jevState('Put me through to switchboard, I want to see that failing test.', 'operator'),
    },
    30,
  );
  s.event(
    {
      kind: 'jev_response',
      utterance_id: 'u-102',
      purpose: 'route',
      latency_ms: 81,
      outcome: 'ok',
      answers: routeAnswers(
        'go_to_project',
        { go_to_project: 0.93, general: 0.04, status: 0.03 },
        0.05,
        'alpha',
        { alpha: 0.96, beta: 0.03, none: 0.01 },
        'fresh',
        0.04,
      ),
    },
    90,
  );
  s.event(
    {
      kind: 'route_decision',
      utterance_id: 'u-102',
      rule: 'jev_action',
      reason: 'Jev action confidence 0.930 met threshold',
      action: 'go_to_project',
      target: 'alpha',
      mode: 'fresh',
      decided_by: 'jev',
    },
    10,
  );
  s.event({ kind: 'pbx_branch', utterance_id: 'u-102', branch: 'go_to_project', reason: 'confident transfer to a registered project' }, 10);
  s.event(
    {
      kind: 'routed',
      utterance_id: 'u-102',
      to_agent: 'alpha',
      text_part: 'Put me through to switchboard, I want to see that failing test.',
      mode: 'fresh',
      via: 'jev',
    },
    20,
  );
  s.event(
    {
      kind: 'agents_state',
      agents: [
        { project: 'alpha', state: 'busy' },
        { project: 'beta', state: 'busy' },
      ],
    },
    20,
  );
  s.event({ kind: 'turn_start', agent: 'alpha', turn_id: 'a-1', generation: 8 }, 30);
  s.event(
    {
      kind: 'agent_input',
      agent: 'alpha',
      turn_id: 'a-1',
      text: 'You are on a live voice call. Keep spoken replies short; put detail on screen with display().',
      source: 'intro',
    },
    10,
  );
  s.event(
    {
      kind: 'agent_input',
      agent: 'alpha',
      turn_id: 'a-1',
      text: 'Caller wants to look at the failing CI run alpha#128 (test pbx::transfer_keeps_epoch).',
      source: 'brief',
    },
    10,
  );
  s.event(
    { kind: 'agent_input', agent: 'alpha', turn_id: 'a-1', text: 'Put me through to switchboard, I want to see that failing test.', source: 'caller' },
    10,
  );
  s.event({ kind: 'module_call', agent: 'alpha', call_id: 'a-m1', name: 'speak', args: { text: 'Pulling up the failing test now.' } }, 300);
  s.event({ kind: 'module_result', agent: 'alpha', call_id: 'a-m1', ok: true, detail: { status: 'delivered' } }, 120);
  s.event({ kind: 'speech', agent: 'alpha', text: 'Pulling up the failing test now.', delivered: true }, 10);
  s.event({ kind: 'tool_start', agent: 'alpha', call_id: 'a-c1', tool: 'bash', args: { command: 'cargo test --locked pbx::transfer_keeps_epoch' } }, 200);
  s.log('DEBUG', 'switchboard::hosts', 'forwarded tool_start', { host: 'builder-1', call_id: 'a-c1' });
  s.event(
    {
      kind: 'tool_end',
      agent: 'alpha',
      call_id: 'a-c1',
      tool: 'bash',
      result: { exit_code: 101, stdout: 'test pbx::transfer_keeps_epoch ... FAILED\n\nassertion `left == right` failed\n  left: 7\n right: 8' },
    },
    900,
  );
  s.event({ kind: 'tool_start', agent: 'alpha', call_id: 'a-c2', tool: 'read', args: { path: 'apps/backend/src/pbx.rs', offset: 1105, limit: 80 } }, 160);
  s.event({ kind: 'tool_end', agent: 'alpha', call_id: 'a-c2', tool: 'read', result: { lines: 80 } }, 110);
  s.event(
    { kind: 'module_call', agent: 'alpha', call_id: 'a-m2', name: 'display', args: { kind: 'code', path: 'apps/backend/src/pbx.rs', focus: [1180, 1192] } },
    200,
  );
  s.event({ kind: 'module_result', agent: 'alpha', call_id: 'a-m2', ok: true, detail: { shown: true } }, 90);
  s.event(
    {
      kind: 'agent_text',
      agent: 'alpha',
      turn_id: 'a-1',
      text: 'The epoch is stamped after the transfer settles, so the test sees generation 7. ',
      final: false,
    },
    260,
  );
  s.event({ kind: 'agent_text', agent: 'alpha', turn_id: 'a-1', text: 'It is on screen now.', final: false }, 160);
  s.event(
    {
      kind: 'agent_text',
      agent: 'alpha',
      turn_id: 'a-1',
      text: 'The epoch is stamped after the transfer settles, so the test sees generation 7. It is on screen now.',
      final: true,
    },
    140,
  );
  s.event({ kind: 'speech', agent: 'alpha', text: 'The epoch is stamped too late. It is on your screen.', delivered: true }, 50);
  s.event({ kind: 'turn_end', agent: 'alpha', turn_id: 'a-1', generation: 8 }, 30);

  // 3. Two asks in one breath: Jev is unsure, the utility splits it.
  s.event(
    {
      kind: 'caller_utterance',
      utterance_id: 'u-103',
      text: 'Fix it and push a branch, and ask homelab whether last night’s backup finished.',
      talking_to: 'alpha',
    },
    1100,
  );
  s.event(
    {
      kind: 'jev_request',
      utterance_id: 'u-103',
      purpose: 'route',
      state: jevState('Fix it and push a branch, and ask homelab whether last night’s backup finished.', 'alpha'),
    },
    30,
  );
  s.event(
    {
      kind: 'jev_response',
      utterance_id: 'u-103',
      purpose: 'route',
      latency_ms: 96,
      outcome: 'ok',
      answers: routeAnswers(
        'continue',
        { continue: 0.48, go_to_project: 0.41, general: 0.11 },
        0.52,
        'beta',
        { beta: 0.55, alpha: 0.4, none: 0.05 },
        'continue',
        0.83,
      ),
    },
    100,
  );
  s.event(
    {
      kind: 'route_decision',
      utterance_id: 'u-103',
      rule: 'asked_llm',
      reason: 'confidence policy requested top-level LLM (action=continue, action_conf=0.480, for_current_agent=0.520)',
      action: 'continue',
      target: 'beta',
      mode: 'continue',
      decided_by: 'jev',
    },
    10,
  );
  s.event({ kind: 'pbx_branch', utterance_id: 'u-103', branch: 'utility', reason: 'Jev unsure and multi_target 0.83: ask the utility to split' }, 10);
  s.event(
    {
      kind: 'utility_request',
      utterance_id: 'u-103',
      attempt: 'first',
      prompt:
        'Caller is on alpha (switchboard). They said: "Fix it and push a branch, and ask homelab whether last night’s backup finished." Registered projects: alpha, beta. Decide the destination or split into parts.',
    },
    20,
  );
  s.event(
    {
      kind: 'utility_decision',
      utterance_id: 'u-103',
      attempt: 'first',
      decision: {
        kind: 'dispatch_parts',
        parts: [
          { project: 'alpha', text: 'Fix the failing test and push a branch.' },
          { project: 'beta', text: 'Did last night’s backup finish?' },
        ],
      },
      latency_ms: 412,
    },
    420,
  );
  s.event(
    { kind: 'routed', utterance_id: 'u-103', to_agent: 'alpha', text_part: 'Fix the failing test and push a branch.', mode: 'continue', via: 'utility' },
    20,
  );
  s.event({ kind: 'routed', utterance_id: 'u-103', to_agent: 'beta', text_part: 'Did last night’s backup finish?', mode: 'continue', via: 'utility' }, 10);
  s.event({ kind: 'turn_start', agent: 'alpha', turn_id: 'a-2', generation: 8 }, 30);
  s.event({ kind: 'agent_input', agent: 'alpha', turn_id: 'a-2', text: 'Fix the failing test and push a branch.', source: 'caller' }, 10);
  s.event({ kind: 'turn_start', agent: 'beta', turn_id: 'b-4', generation: 8 }, 20);
  s.event({ kind: 'agent_input', agent: 'beta', turn_id: 'b-4', text: 'Did last night’s backup finish?', source: 'foreground' }, 10);
  s.event(
    {
      kind: 'tool_start',
      agent: 'alpha',
      call_id: 'a-c3',
      tool: 'edit',
      args: { path: 'apps/backend/src/pbx.rs', old_str: 'let epoch = settled.generation;', new_str: 'let epoch = prewarm.generation;' },
    },
    220,
  );
  s.event(
    { kind: 'tool_start', agent: 'beta', call_id: 'b-c1', tool: 'bash', args: { command: 'ssh nas journalctl -u restic-backup --since yesterday | tail -3' } },
    90,
  );
  s.event({ kind: 'tool_end', agent: 'alpha', call_id: 'a-c3', tool: 'edit', result: { replaced: 1 } }, 160);
  s.event({ kind: 'tool_end', agent: 'beta', call_id: 'b-c1', tool: 'bash', error: 'ssh: connect to host nas port 22: Connection timed out' }, 700);
  s.log('WARN', 'switchboard::hosts', 'project tool failed', { project: 'beta', tool: 'bash' });
  s.event({ kind: 'tool_start', agent: 'beta', call_id: 'b-c2', tool: 'bash', args: { command: 'restic snapshots --latest 1 --json' } }, 140);
  s.event(
    { kind: 'tool_start', agent: 'alpha', call_id: 'a-c4', tool: 'bash', args: { command: 'cargo test --locked && git push -u origin fix/epoch-stamp' } },
    120,
  );
  s.event(
    { kind: 'tool_end', agent: 'beta', call_id: 'b-c2', tool: 'bash', result: { time: '2026-10-02T03:14:09Z', files_new: 212, data_added: '1.4 GiB' } },
    600,
  );
  s.event({ kind: 'agent_text', agent: 'beta', turn_id: 'b-4', text: 'Backup finished at 03:14, 1.4 GiB added.', final: true }, 200);

  // 4. Floor path: beta asks to speak while the caller is on alpha.
  s.event(
    { kind: 'module_call', agent: 'beta', call_id: 'b-m1', name: 'request_to_speak', args: { message: 'Backup finished at 03:14, 1.4 GiB added.' } },
    120,
  );
  s.event({ kind: 'floor_request', agent: 'beta', message: 'Backup finished at 03:14, 1.4 GiB added.' }, 10);
  s.event({ kind: 'floor_held', agent: 'beta', message: 'Backup finished at 03:14, 1.4 GiB added.' }, 20);
  s.event({ kind: 'module_result', agent: 'beta', call_id: 'b-m1', ok: true, detail: { status: 'queued' } }, 10);
  s.event({ kind: 'turn_end', agent: 'beta', turn_id: 'b-4', generation: 8 }, 30);
  s.event(
    {
      kind: 'agents_state',
      agents: [
        { project: 'alpha', state: 'busy' },
        { project: 'beta', state: 'waiting', pending_request: { message: 'Backup finished at 03:14, 1.4 GiB added.' } },
      ],
    },
    20,
  );
  s.event(
    {
      kind: 'jev_request',
      utterance_id: 'gm-17',
      purpose: 'good_moment',
      state: jevState('', 'alpha', { queued_update: 'Backup finished at 03:14, 1.4 GiB added.' }),
    },
    400,
  );
  s.event(
    {
      kind: 'jev_response',
      utterance_id: 'gm-17',
      purpose: 'good_moment',
      latency_ms: 38,
      outcome: 'ok',
      answers: { good_moment: choice('no', { no: 0.71, yes: 0.29 }) },
    },
    40,
  );
  s.event({ kind: 'floor_gate', agent: 'beta', answer: 'no', latency_ms: 38 }, 10);
  s.event(
    {
      kind: 'tool_end',
      agent: 'alpha',
      call_id: 'a-c4',
      tool: 'bash',
      result: { exit_code: 0, stdout: 'test result: ok. 412 passed\nbranch fix/epoch-stamp set up to track origin' },
    },
    900,
  );
  s.event({ kind: 'agent_text', agent: 'alpha', turn_id: 'a-2', text: 'Fixed and pushed fix/epoch-stamp; all 412 tests pass.', final: true }, 200);
  s.event({ kind: 'speech', agent: 'alpha', text: 'Fixed and pushed. All tests pass.', delivered: true }, 60);
  s.event({ kind: 'turn_end', agent: 'alpha', turn_id: 'a-2', generation: 8 }, 20);
  s.event(
    {
      kind: 'jev_request',
      utterance_id: 'gm-18',
      purpose: 'good_moment',
      state: jevState('', 'alpha', { queued_update: 'Backup finished at 03:14, 1.4 GiB added.' }),
    },
    700,
  );
  s.event(
    {
      kind: 'jev_response',
      utterance_id: 'gm-18',
      purpose: 'good_moment',
      latency_ms: 41,
      outcome: 'ok',
      answers: { good_moment: choice('yes', { yes: 0.86, no: 0.14 }) },
    },
    45,
  );
  s.event({ kind: 'floor_gate', agent: 'beta', answer: 'yes', latency_ms: 41 }, 10);
  s.event(
    {
      kind: 'floor_rewrite',
      agent: 'beta',
      original: 'Backup finished at 03:14, 1.4 GiB added.',
      rewritten: 'Quick one from homelab: last night’s backup finished at 3:14.',
      latency_ms: 233,
    },
    240,
  );
  s.event({ kind: 'floor_released', agent: 'beta', how: 'spoken' }, 20);
  s.event({ kind: 'speech', agent: 'beta', text: 'Quick one from homelab: last night’s backup finished at 3:14.', delivered: true }, 30);
  s.event(
    {
      kind: 'agents_state',
      agents: [
        { project: 'alpha', state: 'idle' },
        { project: 'beta', state: 'finished' },
      ],
    },
    20,
  );

  // 5. Vague follow-up: utility unsure twice, the operator's route tool decides.
  s.event({ kind: 'caller_utterance', utterance_id: 'u-104', text: 'Great — tell it to keep the old snapshots too.', talking_to: 'alpha' }, 1200);
  s.event({ kind: 'jev_request', utterance_id: 'u-104', purpose: 'route', state: jevState('Great — tell it to keep the old snapshots too.', 'alpha') }, 30);
  s.event(
    {
      kind: 'jev_response',
      utterance_id: 'u-104',
      purpose: 'route',
      latency_ms: 88,
      outcome: 'ok',
      answers: routeAnswers(
        'go_to_project',
        { go_to_project: 0.52, continue: 0.37, general: 0.11 },
        0.44,
        'beta',
        { beta: 0.51, alpha: 0.45, none: 0.04 },
        'continue',
        0.31,
      ),
    },
    90,
  );
  s.event(
    {
      kind: 'route_decision',
      utterance_id: 'u-104',
      rule: 'asked_llm',
      reason: 'confidence policy requested top-level LLM (action=go_to_project, action_conf=0.520, for_current_agent=0.440)',
      action: 'go_to_project',
      target: 'beta',
      mode: 'continue',
      decided_by: 'jev',
    },
    10,
  );
  s.event({ kind: 'pbx_branch', utterance_id: 'u-104', branch: 'utility', reason: 'Jev unsure between alpha and beta' }, 10);
  s.event(
    {
      kind: 'utility_request',
      utterance_id: 'u-104',
      attempt: 'first',
      prompt: 'Caller is on alpha. They said: "Great — tell it to keep the old snapshots too." Which project?',
    },
    20,
  );
  s.event({ kind: 'utility_decision', utterance_id: 'u-104', attempt: 'first', decision: { kind: 'none' }, latency_ms: 377 }, 380);
  s.event(
    {
      kind: 'utility_request',
      utterance_id: 'u-104',
      attempt: 'split_retry',
      prompt: 'Retry: split the utterance by project if it names more than one; otherwise pick one.',
    },
    20,
  );
  s.event(
    {
      kind: 'utility_decision',
      utterance_id: 'u-104',
      attempt: 'split_retry',
      decision: { kind: 'second_opinion', target: 'beta', mode: 'continue', confident: false },
      latency_ms: 341,
    },
    345,
  );
  s.event({ kind: 'pbx_branch', utterance_id: 'u-104', branch: 'multi_unresolved_to_operator', reason: 'utility not confident after split retry' }, 10);
  s.event({ kind: 'operator_hop', utterance_id: 'u-104', text: 'Great — tell it to keep the old snapshots too.', outcome: 'route_tool' }, 30);
  s.event({ kind: 'turn_start', agent: 'operator', turn_id: 'op-2', generation: 8 }, 20);
  s.event({ kind: 'agent_input', agent: 'operator', turn_id: 'op-2', text: 'Great — tell it to keep the old snapshots too.', source: 'caller' }, 10);
  s.event({ kind: 'tool_start', agent: 'operator', call_id: 'op-c2', tool: 'route', args: { target: 'beta', mode: 'continue' } }, 600);
  s.event({ kind: 'operator_route_tool', utterance_id: 'u-104', target: 'beta', mode: 'continue', action: 'transfer' }, 10);
  s.event({ kind: 'tool_end', agent: 'operator', call_id: 'op-c2', tool: 'route', result: { transferred: 'beta' } }, 40);
  s.event({ kind: 'turn_end', agent: 'operator', turn_id: 'op-2', generation: 8 }, 10);
  s.event(
    { kind: 'routed', utterance_id: 'u-104', to_agent: 'beta', text_part: 'Great — tell it to keep the old snapshots too.', mode: 'continue', via: 'operator' },
    20,
  );
  s.event({ kind: 'turn_start', agent: 'beta', turn_id: 'b-5', generation: 9 }, 30);
  s.event({ kind: 'agent_input', agent: 'beta', turn_id: 'b-5', text: 'Great — tell it to keep the old snapshots too.', source: 'caller' }, 10);
  s.event({ kind: 'agent_text', agent: 'beta', turn_id: 'b-5', text: 'Changing the restic prune policy to ', final: false }, 300);
  s.event({ kind: 'agent_text', agent: 'beta', turn_id: 'b-5', text: 'keep 12 monthly snapshots…', final: false }, 200);

  // 6. Jev times out: the fallback keeps the caller where they are.
  s.event({ kind: 'caller_utterance', utterance_id: 'u-105', text: 'And how long did the tests take?', talking_to: 'beta' }, 1200);
  s.event({ kind: 'jev_request', utterance_id: 'u-105', purpose: 'route', state: jevState('And how long did the tests take?', 'beta') }, 30);
  s.event(
    {
      kind: 'jev_response',
      utterance_id: 'u-105',
      purpose: 'route',
      latency_ms: 1500,
      outcome: 'timeout',
      answers: {},
      error: 'Jev request timed out after 1500 ms',
    },
    1500,
  );
  s.log('WARN', 'switchboard::router', 'Jev unavailable; using fallback', { error: 'timeout' });
  s.event(
    {
      kind: 'route_decision',
      utterance_id: 'u-105',
      rule: 'jev_unavailable',
      reason: 'Jev unavailable: request timed out',
      action: 'continue',
      mode: 'continue',
      decided_by: 'jev',
    },
    10,
  );
  s.event({ kind: 'pbx_branch', utterance_id: 'u-105', branch: 'continue_current', reason: 'fallback keeps the caller on the current leg' }, 10);
  s.event({ kind: 'routed', utterance_id: 'u-105', to_agent: 'beta', text_part: 'And how long did the tests take?', mode: 'continue', via: 'pbx' }, 20);

  // 7. Still in flight.
  s.event({ kind: 'caller_utterance', utterance_id: 'u-106', text: 'Actually, hang on, switch me back to the operator.', talking_to: 'beta' }, 1400);
  s.event({ kind: 'jev_request', utterance_id: 'u-106', purpose: 'route', state: jevState('Actually, hang on, switch me back to the operator.', 'beta') }, 30);
  s.log('INFO', 'switchboard::router', 'Jev request sent', { utterance_id: 'u-106' });
  return s.frames;
}

/** Every frame fixture mode plays: the fixture's snapshot and events, then the call. */
export function fixtureFrames(fixture: FixtureFile): ScriptedFrame[] {
  const frames: ScriptedFrame[] = [];
  const snapshot = parseDebugFrame(fixture.snapshot);
  let seq = 2;
  let ts = 1758844800000;
  if (snapshot.ok && snapshot.value.frame.type === 'snapshot') {
    frames.push({ frame: snapshot.value.frame, delay: 0 });
  } else {
    frames.push({ frame: { type: 'snapshot', events: [], logs: [], agents: [], config: CONFIG }, delay: 0 });
  }
  for (const { event } of fixture.events) {
    if (event.kind === 'caller_utterance') continue; // already in the snapshot
    seq += 1;
    ts += 5;
    frames.push({ frame: { type: 'event', seq, timestamp_ms: ts, ...event } as DebugFrame, delay: 15 });
  }
  return [...frames, ...scriptedCall(seq, ts + 2000)];
}

/** Plays scripted frames through the same handlers a live socket uses. */
export class FixtureFeed implements Feed {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private index = 0;

  constructor(
    private readonly frames: ScriptedFrame[],
    private readonly handlers: FeedHandlers,
    private readonly speed = 1,
    private readonly instant = false,
  ) {}

  start(): void {
    this.handlers.status('fixture');
    if (this.instant) {
      this.handlers.frames(this.frames.map((entry) => entry.frame));
      this.index = this.frames.length;
      return;
    }
    this.step();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resync(): void {}

  private step(): void {
    if (this.index >= this.frames.length) return;
    const batch = [this.frames[this.index].frame];
    this.index += 1;
    while (this.index < this.frames.length && this.frames[this.index].delay < 25) {
      batch.push(this.frames[this.index].frame);
      this.index += 1;
    }
    this.handlers.frames(batch);
    const next = this.frames[this.index];
    if (next) this.timer = setTimeout(() => this.step(), next.delay / this.speed);
  }
}
