# Switchboard debug page

The debug page is an optional, read-only observer. Set `SWITCHBOARD_DEBUG_BIND`
to start its second HTTP listener. When the variable is unset or blank, no debug
listener is opened. If the address cannot be bound, the service logs
`debug listener not started` and keeps serving calls without it.

## Assets

The page is built into the committed `static-debug/` directory as three
fixed-name files: `index.html`, `debug.js` and `debug.css`. The binary embeds
them at compile time (`include_str!` in `apps/backend/src/debug.rs`), and only
the debug listener's router serves them, at `/`, `/debug.js` and `/debug.css`.
Every other path there is a 404, and it has no call controls. The primary
listener serves `static/`, which does not hold the debug page, so no path
spelling there reaches it. A test drives the primary router with encoded and
dot-segment variants of `/debug/` to keep it that way. Because the page is
embedded, deployment copies nothing for it.

The listener shares the service process and its graceful shutdown: on
shutdown each debug WebSocket gets a Close frame. The page is intended for a
trusted network: it can contain caller text, prompts, project activity, and
logs. There is no authentication and no disk history. The event and log rings
are bounded and memory-only.

## The page

The source is `apps/frontend/src/debug/` (entry `apps/frontend/debug/index.html`).
`npm run build` builds it with `apps/frontend/vite.debug.config.ts` into
`static-debug/`, after the main build. Commit the output in the same change.
`npm run dev:debug` serves it on port 4174 and proxies `/ws` to
`SWITCHBOARD_DEBUG_ORIGIN` (default `ws://127.0.0.1:8766`).

- `protocol.ts` parses frames. It rejects an unknown frame type or a malformed
  event and counts it in the top bar. It keeps a numbered event of an unknown
  kind raw, in the raw log tab.
- `reducer.ts` folds frames into route traces per `utterance_id`, one pane per
  agent, floor traces, turns, and logs. A snapshot replaces the projection.
  Frames at or below the newest seen seq are dropped. A seq gap still open
  after 2 seconds makes the page reconnect for a fresh snapshot.
- `connection.ts` reconnects with backoff from 0.5 s up to 10 s.
- A pane item or log line from a record with `"clipped": true` shows a
  `clipped` tag.

`?fixture=1` plays the shared fixture and then a scripted call, with no
listener. `&instant=1` applies it all at once, `&speed=N` changes the pace,
`&select=<utterance_id>` opens a trace, and `&tab=` picks a tab.

## WebSocket framing

The page connects to `/ws` on the debug listener. The page sends nothing; the
listener ignores anything it receives. The first frame is a JSON `snapshot`:

```json
{
  "type": "snapshot",
  "last_seq": 2,
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

After the snapshot, live event frames have `type: "event"`, a `seq`, a
wall-clock `timestamp_ms`, and the event's `kind` and fields at the same level.
Log frames have `type: "log"`, the same `seq` and `timestamp_ms`, and `level`,
`target`, `message` and `fields`. Events and logs share one process-local
sequence space.

Ordering and deduplication:

- One lock covers assigning a `seq`, adding the record to its ring, and sending
  it live, so the rings and the live stream are both in strictly increasing
  `seq` order with no gaps.
- The listener subscribes to the live stream and takes the snapshot under that
  same lock. `last_seq` is the newest `seq` the snapshot covers: every record
  at or below it is in the snapshot or was already evicted from its ring.
- The client must ignore a live frame whose `seq` is at or below the
  `last_seq` of the snapshot it holds. The listener already drops such frames,
  so this rule is a safeguard; it is exact because nothing is lost between
  the snapshot and the first live frame.
- A slow client does not block publishing. If its live receiver falls behind
  (256 frames), the listener drops the backlog, subscribes again at the tail,
  and sends a fresh `snapshot` with a new `last_seq`. The page must replace its
  whole event and log projection with it. Stale frames from before the resync
  are never sent. A client that does not take a frame within 5 seconds is
  disconnected and can reconnect.

Ring capacity is 4,000 events and 2,000 log lines. One record is also bounded
in bytes: each text field is cut at 4 KiB, a JSON value keeps at most 64 items
per array or object, and a record keeps about 16 KiB of text in total. A cut
string ends with `…[clipped]`, a cut array or object gains a
`…[clipped] N more` entry, and the record carries `"clipped": true`. The
field is absent when nothing was cut. Snapshots are serialized on the blocking
pool, never in `publish`.

## Log copy and redaction

A tracing layer copies every log line that passes the service's log filter
(`SWITCHBOARD_LOG`) to the log ring. The same filter governs the journal and
the page. The journal still receives every line unchanged.

Every event and log record is scrubbed before it is clipped and kept, in one
place (`Clip` in `debug.rs`); producers publish raw values:

- A JSON string, or a log field, whose name looks like a credential becomes
  `"[redacted]"`. Names match case-insensitively when they contain `token`,
  `secret`, `password`, `passwd`, `apikey`, `privatekey`, `authorization`,
  `bearer`, `credential` or `cookie`, or have `key` or `keys` as a whole part
  (`api_key`, `x-api-key`; not `keyboard`). Numbers and booleans are kept,
  because they cannot carry a credential (`jev_summary_token_budget`,
  `*_key_configured`).
- In every text field, JSON string and log message, `[redacted]` replaces the
  value after such a name and `=` or `:` (`API_KEY=...`, `"token": "..."`;
  a plain number such as `max tokens: 500` is kept), the word after `Bearer`
  (and after `Authorization: Bearer`), and words with a well-known key prefix
  (`sk-`, `ghp_`, `gho_`, `ghs_`, `github_pat_`, `xoxb-`, `xoxp-`, `glpat-`).

This is a heuristic for a trusted-network page, not a guarantee. It can
redact an innocent phrase such as `token: x`, and it misses a credential
with no recognizable name or prefix. Never log or send a credential on
purpose. Streamed `agent_text` pieces are scrubbed one at a time, so a
credential split across two pieces can be missed; the `final: true` text is
scrubbed whole.

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

Long values are clipped to the record bounds (see "WebSocket framing") and
credentials are scrubbed (see "Log copy and redaction"), in the service,
before a record is kept. A project host agent also clips a tool `args` or
`result` over 4 KB of JSON to `{"clipped": true, "bytes": <full size>,
"preview": "<start of the JSON>"}` before it sends it (`docs/host-link.md`).

Arguments, prompts, and log fields must never contain bearer keys, host tokens,
or call tokens. The debug observer must not delay, cancel, or otherwise alter
call behavior.
