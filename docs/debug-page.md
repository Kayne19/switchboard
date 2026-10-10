# Switchboard debug page

The debug page is an optional, read-only observer. Set `SWITCHBOARD_DEBUG_BIND`
to start its second HTTP listener. When the variable is unset or blank, no debug
listener is opened and nothing is recorded: the event bus and the log copy stay
off, and publishing returns at once. They start only once the listener is
bound. If the address cannot be bound, the service logs
`debug listener not started` and keeps serving calls without it, and without
recording.

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

Browsers do not apply CORS to a WebSocket, so `/ws` checks the origin itself:
a request with an `Origin` header is upgraded only when that origin's host and
port equal the request's `Host` (a default port may be left out on either
side). Any other page a browser on the network opens gets a 403. A request
with no `Origin` (curl, a probe script) is served. The `npm run dev:debug`
proxy forwards the dev server's own `Host`, so it passes.

## The page

The source is `apps/frontend/src/debug/` (entry `apps/frontend/debug/index.html`).
`npm run build` builds it with `apps/frontend/vite.debug.config.ts` into
`static-debug/`, after the main build. Commit the output in the same change.
`npm run dev:debug` serves it on port 4174 and proxies `/ws` to
`SWITCHBOARD_DEBUG_ORIGIN` (default `ws://127.0.0.1:8766`).

- `protocol.ts` parses frames. It rejects an unknown frame type or a malformed
  event and counts it in the top bar. It keeps a numbered event of an unknown
  kind raw, in the raw log tab. A malformed live frame that still has a valid
  `seq` is skipped and counted, and its `seq` is admitted, so it causes no
  resync; only a real gap in the sequence does.
- `reducer.ts` folds frames into route traces per `utterance_id`, one pane per
  agent, floor traces, turns, and logs. A snapshot replaces the projection.
  Frames at or below the newest seen seq are dropped. A seq gap still open
  after 2 seconds makes the page reconnect for a fresh snapshot. A trace that
  a `pbx_branch` `dropped_stale` or `failed` ends is drawn as ended, not as
  still routing.
- `connection.ts` reconnects with backoff from 0.5 s up to 10 s.
- The page looks like the main page because it is drawn with it: it loads
  `src/styles/index.css` before its own `debug.css`, and takes the tokens,
  type and frames from there. Agent text goes through `RichText`, latencies
  through `MetricsPrimitive`, raw records through `CodeViewport`, stage nodes
  through `TechFrame`, and tool calls use the tool-activity line styles.
  `debug.css` only lays these out. Route lines are thin and grey; the lit
  route is orange out and cyan back to the caller, and only a route still in
  flight moves. A line to a pane rises to the bus above the panes and drops
  onto the pane's top rule; a floor request leaves along the bus below. A
  hop that skips a stage node goes around the band, never under the node.
- A pane item or log line from a record with `"clipped": true` shows a
  `clipped` tag.

`?fixture=1` plays the shared fixture and then a scripted call, with no
listener. `&instant=1` applies it all at once, `&speed=N` changes the pace,
`&select=<utterance_id>` opens a trace, and `&tab=` picks a tab.

## WebSocket framing

The page connects to `/ws` on the debug listener. The page sends nothing; the
listener ignores anything it receives, and refuses a frame over 4 KiB. The
first frame is a JSON `snapshot`:

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
  are never sent. A client that falls behind again within 10 seconds of its
  last resync is closed instead, since each resync is a full snapshot; the
  page reconnects with its backoff. A client that does not take a frame
  within 5 seconds is disconnected and can reconnect.

Ring capacity is 4,000 events and 2,000 log lines, and at most 32 MiB of
events and 8 MiB of logs by each record's estimated size; past either bound
the oldest records go first. One record is also bounded in bytes: each text
field is cut at 4 KiB, each name, id or JSON object key at 256 bytes, a JSON
value keeps at most 64 items per array or object, and a record keeps about
16 KiB of text in total, whatever its input. A cut string ends with
`…[clipped]`, a cut array or object gains a `…[clipped] N more` entry, and the
record carries `"clipped": true`. The field is absent when nothing was cut.
A field is cut before it is scrubbed, so publishing a 16 MiB value costs about
as much as a 5 KiB one. Snapshots are serialized on the blocking pool, never
in `publish`.

## Log copy and redaction

A tracing layer copies every log line that passes the service's log filter
(`SWITCHBOARD_LOG`) to the log ring. The same filter governs the journal and
the page. The journal still receives every line unchanged.

Every event and log record is scrubbed before it is kept, in one place
(`Clip` in `debug.rs`); producers publish raw values. A snapshot's `agents`
come from the live projection, not a ring, and go through the same `Clip`
when the snapshot is serialized. Every string is
scrubbed: text, JSON strings and keys, log messages, and names and ids
(`target`, `to_agent`, `tool`, `call_id`, a module call's `name`).

- A JSON value, or a log field, whose name looks like a credential becomes
  `"[redacted]"`, whatever its type: a string, an array or an object. Names
  match case-insensitively when they contain `token`, `secret`, `password`,
  `passwd`, `apikey`, `privatekey`, `authorization`, `bearer`, `credential` or
  `cookie`, or have `key` or `keys` as a whole part (`api_key`, `x-api-key`;
  not `keyboard`). A `null` and a boolean are kept (`*_key_configured`), and so
  is a number whose name also says it is a count (`budget`, `count`, `max`,
  `limit`, `chars`, `bytes`, `tokens`, `size`, `length`, `total`:
  `jev_summary_token_budget`, `input_tokens`). Any other number under such a
  name is redacted (`pin_token`).
- In every string, `[redacted]` replaces a PEM private key block
  (`-----BEGIN ... PRIVATE KEY-----` through its `-----END ...-----` line, or
  to the end of a cut string), the value after a credential-like name and `=`
  or `:` (`API_KEY=...`, `"token": "..."`; a plain number such as
  `max tokens: 500` is kept), and the word after `Bearer` (and after
  `Authorization: Bearer`).
- It also replaces a word that is a credential by its shape: a word of 16 or
  more characters with a well-known key prefix (`sk-`, `ghp_`, `gho_`, `ghu_`,
  `ghs_`, `ghr_`, `github_pat_`, `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-`,
  `xapp-`, `glpat-`, `glsa_`, `hf_`, `npm_`, `AIza`, `pypi-`, `dop_v1_`), an
  AWS access key id (`AKIA` or `ASIA` and 16 upper-case letters or digits), a
  JWT (`eyJ` and two more `.`-separated segments), and a random-looking word:
  32 or more characters that mix upper case, lower case and digits with at
  least 4.2 bits of entropy per character. Lower-case hex digests (git hashes)
  and UUIDs are kept.

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
- `jev_request`: optional `utterance_id` (`route` purpose), `purpose` (`route` or `good_moment`), `state` (the call summary sent to Jev), optional `floor_id` (`good_moment` purpose)
- `jev_response`: optional `utterance_id`, `purpose`, `latency_ms`, `outcome` (`ok`, `invalid`, `timeout`, or `error`), `answers`, optional `error`, optional `floor_id`. `answers` is Jev's raw answer per question: `{"<question>": {"type", "choice", "probabilities", "confidence", "noul"}}`, with `null` for what Jev left out; it is `{}` when Jev gave no answer. `invalid` means Jev answered but the answer could not be used.
- `route_decision`: `utterance_id`, `rule`, `reason`, `action`, optional `target`, `mode` (`continue`, `fresh`, or `not_applicable`), `decided_by` (`jev`, or `fallback` when Jev was unavailable). `rule` is the threshold rule that fired: `jev_action` (action confidence met the threshold), `action_below_threshold`, `stayed_with_current` (on a project, `for_current_agent` reached the upper threshold), `current_agent_unsure` (on a project, `for_current_agent` between the thresholds), `stop_confirms`, or `jev_unavailable`. `reason` says it in plain words with the numbers and thresholds.
- `pbx_branch`: `utterance_id`, `branch`, `reason`; records the branch taken after Jev. `branch` is `stop_confirmed`, `stop_asked`, `take_over`, `answer_waiting`, `utility`, `multi_unresolved`, `go_to_project`, `continue_current`, `operator`, `refused_unknown_target` (Jev, the utility or the operator named a destination that is not a registered project; the switchboard refused it, and a `routed` to `operator` via `pbx` follows, or, for one part of a split, the part was dropped), `dropped_stale` (a newer generation discarded the utterance, or a page rescue cancelled its turn; this ends its trace), or `failed` (the turn worker failed; this ends its trace). An utterance can have two: `utility`, then `multi_unresolved` or `operator` when the utility gave no usable answer.
- `utility_request`: `utterance_id`, `attempt` (`first` or `split_retry`), `prompt`
- `utility_decision`: `utterance_id`, `attempt`, `decision`, `latency_ms`; `decision` is an object with `kind` `second_opinion` (`target`, `mode`, `confident`), `dispatch_parts` (`parts`: `[{project, text}]`), `none`, or `error` (`error`)
- `operator_hop`: `utterance_id`, `text`, `outcome` (`answered`, `route_tool`, `route_tool_without_target`, `failed`, or `unavailable`)
- `operator_route_tool`: `utterance_id`, `target`, `mode`, `action` (`transfer`, `continue`, or `return_to_operator`). The route tool is read from the operator turn that answers the utterance, so it carries that utterance's id.
- `routed`: `utterance_id`, `to_agent`, `text_part`, `mode` (`continue`, `fresh`, `take_over`, or `steer` for words steered into a running turn), `via` (`jev`, `utility`, `operator`, or `pbx`); multiple events represent fan-out from `dispatch_parts`. A caller line handled by the operator has an `operator_hop`; when the operator answers by itself (or its recovery does) the trace ends in a `routed` to `operator` via `operator`, and when it uses its route tool, in `operator_route_tool` and a `routed` to the target via `operator`. A line the switchboard answers itself (a stop question or confirmation, a takeover with no target, a refused destination) ends in a `routed` to `operator` via `pbx`. A `routed` goes out only after its destination is checked against the registry, and a line whose agent turns out to be gone is traced by the operator's hop instead. Every caller line's trace ends in at least one `routed`, or in a `pbx_branch` `dropped_stale` or `failed`. A turn cancelled after it was routed has both: the `routed`, then `dropped_stale`.
- `agent_input`: `agent`, optional `turn_id`, `text`, `source`, optional `utterance_id` (the caller line this input carries, when routing sent one here)
- `agent_text`: `agent`, optional `turn_id`, `text`, `final`
- `tool_start`: `agent`, optional `call_id`, `tool`, optional `args`, optional `turn_id`
- `tool_end`: `agent`, optional `call_id`, `tool`, optional `result`, optional `error`, optional `turn_id`
- `module_call`: `agent`, `call_id`, `name`, `args`, optional `turn_id`
- `module_result`: `agent`, `call_id`, `ok`, `detail`
- `turn_start` and `turn_end`: `agent`, `turn_id`, `generation`, optional `utterance_id`. A caller turn uses the utterance id as `turn_id` and `agent` is the route it started on; a self-woken project turn uses the host's turn id and has no `utterance_id`.
- `rescue`: `generation`, `reason`, optional `leg`
- `speech`: `agent`, `text`, `delivered`, optional `reason` (why it was not delivered, for example `stale_generation`), optional `floor_id` (speech released from the floor)
- `floor_request`: `agent`, `message`, optional `floor_id`; the agent's `request_to_speak` request
- `floor_held`: `agent`, `message`, optional `floor_id`
- `floor_gate`: `agent`, `answer` (`yes`, `no`, or `failed`), `latency_ms`, optional `floor_id`
- `floor_rewrite`: `agent`, `original`, `rewritten`, `latency_ms`, optional `floor_id`; the utility's floor rewrite. `rewritten` equals `original` when the rewrite failed or timed out.
- `floor_released`: `agent`, `how` (`gate_yes`, `quiet_after_hold`, or `dropped_agent_gone`), optional `floor_id`
- `agents_state`: `agents` (the existing `AgentsState` projection), on every change to it, including a `request_to_speak` that marks an agent `waiting`; the caller's page gets the same change at the same time (`app_state::publish_agents`)
- `host_link`: `host`, `connected`; a fenced link closing while its newer link is up is not reported
- `call_boundary`: `phase` (`started` or `ended`), `call_id` (opaque, minted by the service), optional `reason` for `ended` (`page_closed`, `hangup`, or `shutdown`). A call starts when a caller page connects to no open call. A hangup ends it and, while the page stays connected, starts the next one.

`floor_id` (for example `floor-7`) links one background message from
`floor_request` through the good-moment Jev call, the gate, the rewrite, the
release and its `speech`.

`utterance_id` is the caller page's id for the clip (a UUID, or a
`Date.now()`-based id from an older page), capped at 128 characters. The page
assumes it is unique within the ring; it is not scoped to a call.

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
  caller line, a steer included.
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
