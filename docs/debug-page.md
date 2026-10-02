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
- `jev_request`: `utterance_id`, `purpose` (`route` or `good_moment`), `state`
- `jev_response`: `utterance_id`, `purpose`, `latency_ms`, `outcome`, `answers`, optional `error`
- `route_decision`: `utterance_id`, `rule`, `reason`, `action`, optional `target`, `mode`, `decided_by`
- `pbx_branch`: `utterance_id`, `branch`, `reason`; records the branch taken after Jev
- `utility_request`: `utterance_id`, `attempt` (`first` or `split_retry`), `prompt`
- `utility_decision`: `utterance_id`, `attempt`, `decision`, `latency_ms`; `decision` is a serialized object with `kind` `second_opinion`, `dispatch_parts`, `none`, or `error`
- `operator_hop`: `utterance_id`, `text`, `outcome`
- `operator_route_tool`: `utterance_id`, `target`, `mode`, `action`
- `routed`: `utterance_id`, `to_agent`, `text_part`, `mode`, `via` (`jev`, `utility`, `operator`, or `pbx`); multiple events represent fan-out from `dispatch_parts`
- `agent_input`: `agent`, optional `turn_id`, `text`, `source`, optional `utterance_id` (the caller line this input carries, when routing sent one here)
- `agent_text`: `agent`, optional `turn_id`, `text`, `final`
- `tool_start`: `agent`, optional `call_id`, `tool`, optional `args`, optional `turn_id`
- `tool_end`: `agent`, optional `call_id`, `tool`, optional `result`, optional `error`, optional `turn_id`
- `module_call`: `agent`, `call_id`, `name`, `args`, optional `turn_id`
- `module_result`: `agent`, `call_id`, `ok`, `detail`
- `turn_start` and `turn_end`: `agent`, `turn_id`, `generation`
- `rescue`: `generation`, `reason`, optional `leg`
- `speech`: `agent`, `text`, `delivered`, optional `reason`
- `floor_request`: `agent`, `message`; the agent's `request_to_speak` request
- `floor_held`: `agent`, `message`
- `floor_gate`: `agent`, `answer` (`yes`, `no`, or `failed`), `latency_ms`
- `floor_rewrite`: `agent`, `original`, `rewritten`, `latency_ms`; the utility's floor rewrite
- `floor_released`: `agent`, `how`
- `agents_state`: `agents` (the existing `AgentsState` projection)
- `host_link`: `host`, `connected`

Routing events form an ordered multi-hop trace per `utterance_id`: Jev, the PBX
branch, each utility attempt, the operator and its route tool when used, then
one or more `routed` destinations. A `dispatch_parts` utility decision can
fan out to several destination panes. Floor events run in the reverse
direction from an agent through the good-moment gate and optional utility
rewrite to the caller.

## Agent conversations

`agent_input`, `agent_text`, `tool_start`, `tool_end`, `module_call`, and
`module_result` build one chat pane per agent. `agent` names the pane:
`operator`, `utility` (the routing utility), or the project id of a project
leg.

- `agent_input` is what the service sent the agent, as it is sent. `source`
  is `caller` (a routed caller line), `steer` (words added to a running turn),
  `routing_request` or `floor_rewrite` (the utility's two jobs), `brief` (a
  project session's voice brief, sent in front of the first prompt and the
  first after a compaction, shown as an input of its own), `intro` (the first
  prompt of a transfer), `foreground` (a background agent brought back), or
  `model_change`. `utterance_id` is set when the input carries a routed
  caller line.
- `agent_text` with `final: false` is a piece of the reply: a streamed chunk
  from the operator or utility (gathered to about 256 bytes or 250 ms), or one
  finished assistant message from a project agent. `final: true` is the whole
  reply of the turn and replaces the pieces with the same `agent` and
  `turn_id`. A turn that said nothing has no final event.
- `turn_id` for the operator and utility is a per-process prompt number
  (`operator-3`); it groups that prompt's input, text, and tools. For a
  project it is the host agent's turn id, when the host sends one (new hosts
  stamp text, tool events, and the turn's end; inputs have none, because the
  host assigns the id after the prompt arrives).
- `tool_start` and `tool_end` carry the call's `args` and `result` when known:
  always for the operator and utility, and for a project only when its host
  agent sends them (`docs/host-link.md`, "Session events"). An older host
  agent sends the tool name only. `error` is set, with the tool's error text,
  when the tool failed.
- `module_call` and `module_result` pair a project's `switchboard` module call
  (`speak`, `display`, `request_to_speak`, `view`, or a refused name) with the
  service's answer by `call_id`, the host's id for the call. `ok` is true when
  the answer's status is `delivered` or `accepted`; `detail` is the answer.

The pane mirrors what each agent process did, including a turn the call has
since moved away from. Generation and staleness are shown by the turn and
rescue events, not by these.

A value over 4 KB of JSON (tool `args`, `result`, module `args`, `detail`) is
replaced by `{"clipped": true, "bytes": <full size>, "preview": "<start of the
JSON>"}`; text over 16 KB is cut and ends with `[clipped: <n> bytes in all]`.
Before that, the service replaces credential-looking strings with
`[redacted]`: string fields whose names look like credentials (`token`,
`secret`, `password`, `api_key`, `authorization`, and similar), the value
after such a name and `=` or `:` in text, the word after `Bearer`, and words
with a well-known key prefix (`sk-`, `ghp_`, ...). It is a heuristic for a
trusted-network page, not a guarantee.

Arguments, prompts, and log fields must never contain bearer keys, host tokens,
or call tokens. The debug observer must not delay, cancel, or otherwise alter
call behavior.
