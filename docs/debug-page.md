# Switchboard debug page

The debug page is an optional, read-only observer. Set `SWITCHBOARD_DEBUG_BIND`
to start its second HTTP listener. When the variable is unset or blank, no debug
listener is opened. The normal listener does not serve `/debug` assets.

The listener serves the page from `static/debug/` and accepts a WebSocket at
`/ws` relative to that listener. It shares the service process and its graceful
shutdown, but it has no call controls. The page is intended for a trusted
network: it can contain caller text, prompts, project activity, and logs.
There is no authentication or disk history. The event and log rings are
bounded and memory-only.

## WebSocket framing

The first frame is a JSON `snapshot`:

```json
{
  "type": "snapshot",
  "events": [],
  "logs": [],
  "agents": [],
  "config": {
    "jev_for_current_agent_lower": 0.3,
    "jev_for_current_agent_upper": 0.7,
    "jev_action_threshold": 0.6
  }
}
```

After the snapshot, live event frames have `type: "event"`, a monotonically
increasing `seq`, a wall-clock `timestamp_ms`, and the event's `kind` and
fields at the same level. Log frames have `type: "log"` and the same sequence and
timestamp fields. Event and log sequences share one process-local sequence
space; a reconnect receives the current ring again.

A slow client does not block publishing. If its live broadcast receiver falls
behind, the listener drops the missed frames and sends a fresh `snapshot` frame
instead. The page must replace its retained event/log projection with that
snapshot. Ring capacity is approximately 4,000 events and 2,000 log lines.

## Event schema

Rust `DebugEvent` in `apps/backend/src/debug.rs` is the source of truth. The
`kind` values are:

- `caller_utterance`: `utterance_id`, `text`, `talking_to`
- `jev_request`: optional `utterance_id` (`route` purpose), `purpose` (`route` or `good_moment`), `state` (the call summary sent to Jev), optional `floor_id` (`good_moment` purpose)
- `jev_response`: optional `utterance_id`, `purpose`, `latency_ms`, `outcome` (`ok`, `invalid`, `timeout`, or `error`), `answers`, optional `error`, optional `floor_id`. `answers` is Jev's raw answer per question: `{"<question>": {"type", "choice", "probabilities", "confidence", "noul"}}`, with `null` for what Jev left out; it is `{}` when Jev gave no answer. `invalid` means Jev answered but the answer could not be used.
- `route_decision`: `utterance_id`, `rule`, `reason`, `action`, optional `target`, `mode` (`continue`, `fresh`, or `not_applicable`), `decided_by` (`jev`, or `fallback` when Jev was unavailable). `rule` is the threshold rule that fired: `jev_action` (action confidence met the threshold), `action_below_threshold`, `stayed_with_current` (on a project, `for_current_agent` reached the upper threshold), `current_agent_unsure` (on a project, `for_current_agent` between the thresholds), `stop_confirms`, or `jev_unavailable`. `reason` says it in plain words with the numbers and thresholds.
- `pbx_branch`: `utterance_id`, `branch`, `reason`; records the branch taken after Jev. `branch` is `stop_confirmed`, `stop_asked`, `take_over`, `answer_waiting`, `utility`, `multi_unresolved`, `go_to_project`, `continue_current`, `operator`, or `dropped_stale` (a newer generation discarded the utterance; this ends its trace). An utterance can have two: `utility`, then `multi_unresolved` or `operator` when the utility gave no usable answer.
- `utility_request`: `utterance_id`, `attempt` (`first` or `split_retry`), `prompt`
- `utility_decision`: `utterance_id`, `attempt`, `decision`, `latency_ms`; `decision` is an object with `kind` `second_opinion` (`target`, `mode`, `confident`), `dispatch_parts` (`parts`: `[{project, text}]`), `none`, or `error` (`error`)
- `operator_hop`: `utterance_id`, `text`, `outcome` (`answered`, `route_tool`, `route_tool_without_target`, `failed`, or `unavailable`)
- `operator_route_tool`: `utterance_id`, `target`, `mode`, `action` (`transfer`, `continue`, or `return_to_operator`). The route tool is read from the operator turn that answers the utterance, so it carries that utterance's id.
- `routed`: `utterance_id`, `to_agent`, `text_part`, `mode` (`continue`, `fresh`, `take_over`, or `steer` for words steered into a running turn), `via` (`jev`, `utility`, `operator`, or `pbx`); multiple events represent fan-out from `dispatch_parts`, and a `routed` to `operator` followed by the operator's route tool is a two-hop path
- `agent_input`: `agent`, optional `turn_id`, `text`, `source`
- `agent_text`: `agent`, optional `turn_id`, `text`, `final`
- `tool_start`: `agent`, optional `call_id`, `tool`, optional `args`
- `tool_end`: `agent`, optional `call_id`, `tool`, optional `result`, optional `error`
- `module_call`: `agent`, `call_id`, `name`, `args`
- `module_result`: `agent`, `call_id`, `ok`, `detail`
- `turn_start` and `turn_end`: `agent`, `turn_id`, `generation`, optional `utterance_id`. A caller turn uses the utterance id as `turn_id` and `agent` is the route it started on; a self-woken project turn uses the host's turn id and has no `utterance_id`.
- `rescue`: `generation`, `reason`, optional `leg`
- `speech`: `agent`, `text`, `delivered`, optional `reason` (why it was not delivered, for example `stale_generation`), optional `floor_id` (speech released from the floor)
- `floor_request`: `agent`, `message`, optional `floor_id`; the agent's `request_to_speak` request
- `floor_held`: `agent`, `message`, optional `floor_id`
- `floor_gate`: `agent`, `answer` (`yes`, `no`, or `failed`), `latency_ms`, optional `floor_id`
- `floor_rewrite`: `agent`, `original`, `rewritten`, `latency_ms`, optional `floor_id`; the utility's floor rewrite. `rewritten` equals `original` when the rewrite failed or timed out.
- `floor_released`: `agent`, `how` (`gate_yes`, `quiet_after_hold`, or `dropped_agent_gone`), optional `floor_id`
- `agents_state`: `agents` (the existing `AgentsState` projection)
- `host_link`: `host`, `connected`; a fenced link closing while its newer link is up is not reported
- `call_boundary`: `phase` (`started` or `ended`), `call_id` (opaque, minted by the service), optional `reason` for `ended` (`page_closed`, `hangup`, or `shutdown`). A call starts when a caller page connects to no open call. A hangup ends it and, while the page stays connected, starts the next one.

`floor_id` (for example `floor-7`) links one background message from
`floor_request` through the good-moment Jev call, the gate, the rewrite, the
release and its `speech`.

Routing events form an ordered multi-hop trace per `utterance_id`: Jev, the PBX
branch, each utility attempt, the operator and its route tool when used, then
one or more `routed` destinations. A `dispatch_parts` utility decision can
fan out to several destination panes. Floor events run in the reverse
direction from an agent through the good-moment gate and optional utility
rewrite to the caller.

Arguments, prompts, and log fields must never contain bearer keys, host tokens,
or call tokens. The debug observer must not delay, cancel, or otherwise alter
call behavior.
