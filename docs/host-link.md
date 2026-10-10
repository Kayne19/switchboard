# Host link and skill socket

This is the contract between the host agent (`apps/host-agent/`, the client)
and the switchboard service (the server), and between the host agent and the
`switchboard` Python skill module on the same host. The daemon findings the
host agent follows are in `docs/host-agent.md`.

The host agent runs on each project host as the user. It dials out to the
service over one WebSocket, drives the user's shared prime-agent daemon
through a `DaemonPort` (`apps/host-agent/src/daemon_port.ts`), and serves the
skill module on a local Unix socket.

## Running it

```sh
node apps/host-agent/src/main.ts [--config <file>]
```

- Node 22.18 or later: the sources are TypeScript run directly by Node's type
  stripping (erasable syntax only, no build step).
- `--config` defaults to `~/.config/switchboard/host-agent.json`.
- The host agent connects to the daemon's socket and never starts a daemon.
  While the socket is absent it retries with capped backoff (1 s doubling to
  30 s). The daemon runs in its own systemd user unit.

### Config file

One JSON file; `main.ts` is its only reader at run time. The installer
(`apps/host-agent/install.mjs`) writes it and reads it back on a rerun.
`~/` is expanded.

```json
{
  "host_id": "scriptorium",
  "service_url": "wss://switchboard.home.arpa/host",
  "token_file": "~/.config/switchboard/host-token",
  "git_sha": "d95f029...",
  "prime_agent": "~/.local/npm-global/bin/prime-agent",
  "prime_agent_package": "~/.local/npm-global/lib/node_modules/prime-agent",
  "daemon_socket": "/tmp/prime-agent-1000/daemon.sock",
  "state_dir": "~/.local/state/switchboard/host-agent"
}
```

| Key | Required | Meaning |
|---|---|---|
| `host_id` | yes | The host's id, as the service's host registry knows it. |
| `service_url` | yes | `ws://` or `wss://` URL of the service's `/host` endpoint. |
| `token_file` | yes | File holding the per-host bearer token (surrounding whitespace is trimmed). The token is never logged. |
| `prime_agent_package` | yes | Directory of the installed `prime-agent` npm package; `dist/index.js` is loaded at runtime. |
| `prime_agent` | no | The `prime-agent` binary the daemon unit runs. Only the installer reads it, on a rerun; the host agent ignores it. |
| `git_sha` | no (`unknown`) | Commit the host agent was installed from; reported in the hello. |
| `daemon_socket` | no | Default `$TMPDIR/prime-agent-<uid>/daemon.sock` (the daemon's default). |
| `state_dir` | no | Default `~/.local/state/switchboard/host-agent`. Holds `sessions.json`. |

The skill socket's path is not a setting: the Python skill has
`~/.cache/switchboard/host-agent.sock` built in and reads no configuration,
so the host agent listens there and nowhere else (see "Skill socket"). A
`skill_socket` key in an older config file is ignored.

### State file

`<state_dir>/sessions.json` (0600, written atomically) keeps provenance and
every session name the host agent ever minted, so a restart keeps both:

```json
{
  "version": 1,
  "sessions": [
    { "handle": "a1b2", "session_id": "0199...", "name": "sb-homelab-3f9c01aa", "project": "homelab", "cwd": "/srv/homelab", "provenance": "created" }
  ],
  "used_names": ["sb-homelab-3f9c01aa"]
}
```

## Host link

A WebSocket at the service's `/host`. Every frame is one JSON text message
with a `type`.

### Identifiers

- `session` is the daemon's live handle (`activeSessionId`). Every command
  and event about a live session uses it.
- `session_id` is the persisted session id. It survives a kill, is what
  `open_session` takes, and is the basename of the kernel's `RLM_SESSION_DIR`
  (the skill socket's key).
- A `cursor` is `"<boot_id>:<sequence>"`. `boot_id` is new on every
  host-agent start; `sequence` increases across all sessions of one boot.

### Hello, welcome, refusal

The host agent sends `hello` as its first frame:

```json
{
  "type": "hello",
  "host_id": "scriptorium",
  "token": "<per-host bearer token>",
  "protocol": 1,
  "git_sha": "d95f029...",
  "boot_id": "5c2e9a0b41d7",
  "prime_agent": { "client_version": "0.9.5", "daemon_version": "0.9.6", "daemon_protocol": 7 }
}
```

`protocol` is the host-link protocol version (currently `1`). The service
refuses a bad token or an incompatible protocol and closes the socket:

```json
{ "type": "refused", "reason": "bad_token", "message": "unknown host or token" }
{ "type": "refused", "reason": "incompatible_protocol", "message": "host-link protocol 1 is not supported" }
```

After a refusal the host agent redials with capped backoff (1 s doubling to
30 s), so a fixed token or a redeployed service is picked up without a
restart.

On success the service answers `welcome`:

```json
{ "type": "welcome", "epoch": 7, "protocol": 1, "cursors": { "a1b2": "5c2e9a0b41d7:42" } }
```

- `epoch` is the link epoch. The service gives each accepted link of a host a
  larger epoch; a newer link fences older ones.
- `cursors` holds, per session, the last event cursor the service received
  from this host. A session the service never heard of is absent.

After the welcome the host agent brings the service up to date, per tracked
session:

- if the cursor carries this boot's id and the host agent's buffer still
  holds every later event, it replays them (`"replayed": true`);
- otherwise (no cursor, another boot id after a host-agent restart, or the
  buffer no longer reaches back that far) it sends a fresh `snapshot`;
- for a session in `cursors` that the host agent no longer tracks, it replays
  the buffered events (ending with `session_closed`) when it can, or else
  sends a new `session_closed` event with reason `gone`.

Then it sends `{ "type": "synced", "epoch": 7 }`. The buffer keeps the last
1000 events per session.

### Heartbeat

Both sides send `{ "type": "ping" }` every 10 s and answer each ping with
`{ "type": "pong" }`. A side that sent 3 pings without a pong since drops the
link. The host agent then redials.

### Commands and replies

The service sends commands; every command carries the current `epoch`:

```json
{ "type": "command", "id": "c17", "epoch": 7, "name": "prompt", "args": { "session": "a1b2", "message": "..." } }
```

The host agent answers on the same link:

```json
{ "type": "reply", "id": "c17", "epoch": 7, "ok": true, "result": { "sent_as": "prompt" } }
{ "type": "reply", "id": "c18", "epoch": 7, "ok": false, "error": { "code": "refused", "message": "session a1b2 was taken over; it can only be detached" } }
```

A command whose `epoch` is not the current link's epoch is not run:

```json
{ "type": "reply", "id": "c19", "epoch": 7, "ok": false, "error": { "code": "stale_epoch", "message": "epoch 6 is not the current link epoch" } }
```

A reply is sent only on the link the command came from; if that link is gone,
the reply is dropped.

A reply the service cannot read (see "Frames the service cannot read")
fails its command at once with the code `unreadable_reply`, rather than
leaving it to wait out its deadline.

Error codes:

| Code | Meaning |
|---|---|
| `stale_epoch` | The command's epoch is not the current link epoch. |
| `bad_request` | A missing or invalid argument. |
| `unknown_command` | No such command. |
| `not_found` | The session is not tracked by this host agent. |
| `refused` | Not allowed (kill of a session the service did not create, `open_session` of a non-`sb-` session, `set_mode` off a call). |
| `unsupported` | The daemon does not support the command (per-command compatibility); other commands keep working. |
| `daemon_error` | The daemon ran the command and it failed; `message` has the daemon's text. |
| `failed` | Anything else. |

The service stops using a session after any failed command to it (any code
above, or no reply within its 30 s wait), but it still releases the
session: it sends `kill` for one it created and `abort` then `detach` for
one it took over. Only a `session_closed` event tells it the session is
already gone; then it sends no `kill`, and still sends `abort` then
`detach` for a session it took over. "A project session's end" has the
whole table.

### Commands

A session description (`info`) as returned by `create_session`,
`open_session` and in snapshots:

```json
{
  "session": "a1b2",
  "session_id": "0199...",
  "name": "sb-homelab-3f9c01aa",
  "project": "homelab",
  "cwd": "/srv/homelab",
  "provenance": "created",
  "busy": false,
  "turn_open": false,
  "turn_id": null,
  "cause": null,
  "model": "anthropic/claude-sonnet-5",
  "thinking": "high",
  "call_mode": null,
  "last_text": "Done. The tests pass."
}
```

`thinking` is the effective level the daemon reports (it clamps levels the
model does not have). `call_mode` is `null` when the session is not on a call.

| Command | Args | Result |
|---|---|---|
| `create_session` | `project`, `config: {cwd, provider?, model?, thinking?}` | `info` |
| `open_session` | `session_id`, `cwd`, `project?` | `info` |
| `attach` | `session`, `project`, `cwd` | `info` |
| `list_sessions` | — | `{sessions: [...]}` |
| `prompt` | `session`, `message` | `{sent_as: "prompt" \| "follow_up"}` |
| `steer` | `session`, `message` | `{sent_as: "steer"}` |
| `abort` | `session` | `{aborted: true}` |
| `kill` | `session` | `{killed: true}` |
| `detach` | `session` | `{detached: true}` |
| `join_call` | `session`, `token`, `persona`, `speech_deadline_ms`, `mode?` | `{on_call: true, mode}` |
| `set_mode` | `session`, `mode` | `{mode}` |
| `set_model` | `session`, `provider`, `model` | `{model, thinking}` |
| `set_thinking` | `session`, `level` | `{model, thinking}` |
| `list_models` | — | `{models: [{provider, id, name, reasoning}]}` |
| `run_prepare` | `cwd`, `command`, `timeout_ms?` | prepare result |

- **`create_session`** always creates a resident session
  (`lifecycle: "resident"`) named `sb-<project>-<8 hex>`. A name is never
  reused: the daemon never frees one, even after a kill, so the host agent
  keeps every minted name and mints a new one if the daemon reports a name
  taken. The config passes only `cwd`, `provider`, `model` and `thinking`:
  no `appendSystemPrompt` (it would replace the project's
  `APPEND_SYSTEM.md`) and no tool list, so `ipython` stays. The host agent
  attaches to the session for its events. `project` must match
  `[A-Za-z0-9][A-Za-z0-9_-]*`.
- **`open_session`** reopens a saved session by id (or `.jsonl` path) as a
  resident session in `cwd` and attaches. `cwd` is required: without it the
  daemon runs the reopened session in its own working directory, not the
  project folder (measured against a real daemon). Only names starting `sb-` (or
  `sb-<project>-` when `project` is given) are accepted; others are refused.
  The name is checked on the saved record *before* the session is reopened:
  a daemon `create` with a session path makes the session live (or returns
  it, if another client has it open), so a refusal after that step would
  leave a stranger's session running unseen, and killing it would be wrong
  in the already-open case (#162). Reopening a live session returns it.
  A session this host agent already tracks is returned only if it was
  created by the switchboard (provenance `created`), carries the expected
  name (and `project`, when given), and runs in `cwd`; otherwise the command
  is refused.
- **`list_sessions`** lists live top-level daemon sessions (subagents are
  left out): `{session, session_id, name, cwd, busy, provenance, project,
  model, thinking}`. `provenance` is `"created"`, `"taken_over"`, or `null`
  for a session the service has nothing to do with.
- **`prompt`** on a session with an open turn is sent as `follow_up`, and a
  prompt the daemon refuses as busy is resent as `follow_up`; the daemon
  refuses plain prompts on a busy session.
- **`abort`** is always followed by `resume_queue` (the daemon suspends
  queued input after an abort; `resume_queue`'s "No queued work" error is
  ignored), then, when a turn is open, by `wait_for_idle`, which settles it.
- **`kill`** is only for sessions with provenance `created`. It is refused
  for `taken_over` sessions and for sessions the host agent does not track.
  The transcript stays and can be reopened with `open_session`.
- **`detach`** ends the call, detaches from the daemon session and stops
  tracking it. The session keeps running. After it the module answers "not on
  a call".
- **`join_call`** puts a tracked session on a call: the skill module's hello
  then returns the token, persona and speech deadline given here. `mode`
  defaults to `foreground`. `detach` and `kill` take it off. The service
  sends a new token for every call.
- **`set_mode`** changes the mode of a session on a call: `foreground`,
  `background` or `active`. See "Delivery" below.
- **`set_model`** and **`set_thinking`** read the state back and return the
  model and the effective thinking level; they also emit a `state` event.
- **`list_models`** returns the models this host's prime-agent can use (the
  installed package's model registry, the same models and auth files the
  daemon reads).
- **`run_prepare`** runs `sh -c <command>` in `cwd`. Output is bounded: the
  last 16 KiB of each stream is kept. The default timeout is 10 minutes; on
  timeout the process group is killed. It answers when the shell exits, with
  the shell's status: output is read for 500 ms more at most
  (`PREPARE_DRAIN_MS`), then the host agent closes its ends of the pipes. A
  process the command left running (`server &`) is not waited for and not
  killed, but the next time it writes to the inherited stdout or stderr it
  gets SIGPIPE, which ends it unless it ignores the signal; give it its own
  output (`server >server.log 2>&1 &`).

  ```json
  { "outcome": "timed_out", "exit_code": null, "signal": "SIGKILL", "stdout": "...", "stderr": "", "truncated": false, "duration_ms": 600004 }
  ```

  `outcome` is `succeeded`, `failed` or `timed_out`.

  A `run_prepare` for the same `cwd` and `command` as one still running
  starts nothing: it waits for that run and answers with its result (its
  `timeout_ms` is the first run's). The service sends a prepare again when
  the link it was sent on drops, and the host agent keeps running the first;
  two copies in one folder would race each other.

- **`attach`** adopts one live top-level desk session in the exact registered
  `cwd`, without creating or reopening it. It records provenance
  `taken_over`, subscribes to its events, and persists that provenance. The
  session remains inert to the skill module until `join_call`; `detach` is the
  only release path and never kills it. A tracked session or a folder
  mismatch is refused; a session that is not live or not top-level is
  `not_found`.

### Session events

The host agent sends every session event with its cursor:

```json
{ "type": "event", "session": "a1b2", "cursor": "5c2e9a0b41d7:43", "event": { "kind": "turn_start", "cause": "input", "turn_id": "turn-7" } }
```

| `event.kind` | Fields | Meaning |
|---|---|---|
| `turn_start` | `cause`: `input` \| `autonomous` \| `unknown`, `turn_id?` | A turn opened: after an input, or an `agent_start` nobody caused (a subagent finished, a schedule, a heartbeat). `turn_id` is stable for the turn. A busy snapshot rebuilt after a host-agent restart uses `unknown` and has no delivery authority. |
| `turn_end` | `error?`, `turn_id?` | The turn settled: `wait_for_idle`, sent after the last input, resolved. `error` is set when that wait failed. |
| `tool_start` | `tool`, `call_id`, `args?`, `turn_id?` | A tool call started. `args` is the call's arguments. |
| `tool_end` | `tool`, `call_id`, `error`, `result?`, `turn_id?` | A tool call ended. `error` is true when the tool failed; `result` is what the tool returned. |
| `text` | `text`, `turn_id?` | An assistant message ended with this text. New hosts stamp the owning turn id. |
| `error` | `message` | A model error, or retries exhausted. |
| `compaction` | `phase`: `start` \| `end`, `reason` | The daemon compacted the context. The service resends the voice brief on the next routed line after `end`. |
| `state` | `model`, `thinking` | Model and effective thinking level after `set_model` or `set_thinking`. |
| `session_closed` | `reason`: `killed` \| `detached` \| `gone` \| `host_link_closed` | The host agent stopped tracking the session (`gone`: the daemon no longer has it — it was missing at a resync, or the daemon announced its close, as it does when another client kills it). `host_link_closed` never crosses the wire: the service synthesizes it for every subscribed session when the host's link drops, so a subscriber sees the session end the same way whether the host let go of it or went away. |

A turn is not ended by `agent_end`: the daemon repeats it within one turn.
Only `turn_end` means settled.

On the host agent, a tracked session's turn is one record,
`Tracked.turn` in `apps/host-agent/src/sessions.ts`: idle (`null`), or open
with its `turn_id` and `cause`. `SessionManager.#turnStep` is its only
writer, and it sends `turn_start` and `turn_end`:

| Turn | Event | Next | Sent |
|---|---|---|---|
| idle | an input is sent (`prompt`, `steer`, or `prompt` resent as `follow_up`) | open, `input` | `turn_start`, then `wait_for_idle` |
| idle | `agent_start` while an input is in flight | open, `input` | `turn_start` (the input sends the `wait_for_idle`) |
| idle | `agent_start` with no input in flight | open, `autonomous` | `turn_start`, then `wait_for_idle` |
| idle | a resync finds the session busy | open, `unknown` (no `turn_id`) | `turn_start`, then `wait_for_idle` |
| open | an input, or a resync | open | a new `wait_for_idle`; the earlier one no longer settles |
| idle | `abort` | idle | `resume_queue`; no `wait_for_idle` |
| open | `abort` | open | `resume_queue`, then a new `wait_for_idle` |
| open | `agent_start` | open | nothing: one more run of the same turn |
| open | the latest `wait_for_idle` resolves | idle | `turn_end` |
| open | the latest `wait_for_idle` fails | idle | `turn_end` with `error` |
| open | an earlier `wait_for_idle` answers | open | nothing |
| any | `kill`, `detach`, the daemon's close, or a resync that finds it gone | untracked | `session_closed` only; it stands for the turn's end |

Each `wait_for_idle` carries the input count it was sent after; an answer
settles the turn only if no input came after it and the session is still
the same record. The table test in `apps/host-agent/tests/sessions.test.ts`
("turn table") holds every row.

`args`, `result` and the `turn_id` on tool events are additive and optional.
They feed the service's debug page (`docs/debug-page.md`) and nothing else; an
older host omits them and the service shows the tool name only. A value whose
JSON is over 4 KB is sent as `{"clipped": true, "bytes": <full size>,
"preview": "<start of the JSON>"}` instead. They are sent whether or not
the service's debug page is on, so a tool pair can add about 8 KB to a
session's replay buffer. The host does not scrub them: the service scrubs
credentials before a debug record is kept. The host sends assistant text once
per message (`text`), not as streamed deltas: one delta per token would fill
the per-session replay buffer of 1000 events and make a reconnect lose its
replay.

### A project session's turn

The service keeps one turn state per project session: `TurnState` in
`apps/backend/src/session_turn.rs`. `TurnState::step` is its only writer.
It runs under the turn's lock and returns what is left to do (hand a frame
to the caller's prompt, report a turn boundary to the application, ask the
application to admit a self-woken start, or end a self-woken run), which
the session's pump does once the lock is released. The application's
answer to an admission comes back as an event of its own, so nothing
waits under the lock.

| Phase | Busy | A frame of no turn the session holds | A module call that names no turn |
|---|---|---|---|
| idle | no | reaches nobody | has no cause |
| caller (a prompt is collecting its turn) | yes | goes to the prompt | has no cause |
| self-woken (a run no prompt collects is held) | yes | is dropped | gets the run's cause |
| caller and self-woken (the application admitted a run behind the caller's settled turn before the prompt returned) | yes | is dropped | gets the run's cause |
| caller settled (that run ended; the prompt has not returned yet) | no | goes to the prompt | has no cause |

| From | Event | Next | Done |
|---|---|---|---|
| idle | a prompt starts | caller | |
| self-woken | a prompt starts | caller and self-woken | |
| caller, caller settled | the prompt returns or is cancelled | idle | |
| caller and self-woken | the prompt returns or is cancelled | self-woken | |
| idle | `turn_start`, `autonomous` or `unknown` | self-woken | start reported; the answer is not used |
| caller, caller settled | `turn_start`, `autonomous` or `unknown` | admitted: caller and self-woken; refused: unchanged | start reported; refused, it goes to the prompt |
| caller and self-woken | `turn_start`, `autonomous` or `unknown` | unchanged | goes to the prompt; nothing reported |
| self-woken | `turn_start`, `autonomous` or `unknown` | unchanged | its turn id is remembered as refused |
| any | `turn_start`, `input` | unchanged | start reported; the refused id is forgotten |
| self-woken, caller and self-woken | `text` of the run | unchanged | the run keeps it |
| self-woken, caller and self-woken | `turn_end` of the run, or an idle snapshot naming it | idle, caller settled | final text published; end reported with it (a snapshot's `last_text` stands in for none) |
| self-woken, caller and self-woken | `session_closed` | idle, caller settled | final text published; end reported without it; goes to the prompt |
| caller, caller settled | `turn_end` | unchanged | goes to the prompt, which it ends; with a turn id, reported as an `input` turn's end |
| idle | `turn_end` with a turn id | idle | reported as an `input` turn's end |
| idle | a snapshot with a turn open | self-woken | start reported, with the snapshot's cause |
| any | another snapshot | unchanged | goes to the prompt |
| any | `text` or `turn_end` of the refused turn id | unchanged | dropped; its `turn_end` forgets it |

The session's end of life (below) is a state of its own: `session_closed`
moves both. The table test `a_project_session_turn_moves_by_its_table`
(`apps/backend/tests/test_project_session.rs`) holds every phase against
every event.

### A project session's end

The service keeps one end-of-life state per project session:
`Lifecycle` in `apps/backend/src/project_session.rs`. `Lifecycle::after`
is its table and `ProjectInner::end` its only writer.

| Phase | Commands | The session's frames | Release owed |
|---|---|---|---|
| open | sent | read | yes |
| unusable (a command failed) | refused by the service | read, so a turn already running can settle | yes |
| ended on host (`session_closed`) | refused by the service | not read | only by a session it took over |
| released | refused by the service | not read | no: it went out |

| From | A command fails | `session_closed` | The owner closes it, or its last handle drops |
|---|---|---|---|
| open | unusable; the application is told | ended on host; the application is told | released |
| unusable | unusable | ended on host | released |
| ended on host | ended on host | ended on host | taken over: released; created: ended on host |
| released | released | released | released |

A failed command is any error code above, or no reply within the 30 s
wait. `session_closed` includes the service's own `host_link_closed`.
"The application is told" is the session-closed callback, which evicts a
background resident at once; the owner's close is not reported back to
it. Entering released sends the release: `kill` for a session the service
created, `abort` then `detach` for one it took over, which is never killed.

The session's frames come through a subscription to its handle
(`hosts.rs`, `Subscription`) that the open and unusable phases hold:
leaving them, or dropping the last handle, ends it. A subscription ends
only itself: the host agent answers a reopen of a session it still
tracks with the handle it already had, so a newer subscription to the
same handle may have replaced an old one, and the old one letting go
leaves the newer in place. The table test
`a_project_session_ends_by_its_table`
(`apps/backend/tests/test_project_session.rs`) holds every row.

### Snapshots

A snapshot replaces what the service knows about a session:

```json
{ "type": "snapshot", "session": "a1b2", "cursor": "5c2e9a0b41d7:43", "info": { "session": "a1b2", "...": "see info above" } }
```

The host agent sends one after the welcome when it cannot replay (see
above), and after it reconnects to a replaced daemon. Its cursor is taken
before the session is described, and an event published while it is being
described is sent after it: the snapshot is the baseline for everything up
to its cursor, so an event sent before it but not reflected in it would be
lost (#164). After a host-agent
restart it rebuilds each tracked session from the daemon: sessions the
daemon still has are reattached (a busy one gets an open turn, settled by
`wait_for_idle`); sessions it no longer has get `session_closed`. The
snapshot carries the state, not the transcript.

Each session is reattached on its own, at start and after a reconnect. A
session whose `attach` fails and that the daemon no longer lists gets
`session_closed` `gone`; the others are reattached and snapshotted anyway.
One the daemon still lists stays tracked (its provenance is kept) and gets
no events until it attaches. Commands to it still run on the daemon (it
does not ask for an attach to take a prompt); only its events are missing.
The host agent tries again, with the connect backoff (1 s, doubling to
30 s), to attach only the sessions that would not attach, until every
listed session is attached: the sessions already attached are not
reattached, and are not snapshotted again. A session detached or killed
while its reattach is in flight stays released; the reattach does not
track it again. A resync that fails as a whole (the daemon cannot `list`)
is run again whole, with the same backoff, at start too: the host agent
starts its link without those sessions rather than exit.

`DaemonKeeper` (`apps/host-agent/src/daemon_keeper.ts`) owns this. Its
phase is one value, written only by `#step`:

| Phase | Event | Next | Done |
|---|---|---|---|
| `disconnected` | start, or the daemon closed | `resyncing` once connected | dial with the connect backoff until the daemon answers (it never starts one) |
| `resyncing` | the resync attaches every listed session | `attached` | snapshot each session it attached |
| `resyncing` | the resync leaves sessions unattached | `retrying` (those sessions) | snapshot the rest; wait the backoff |
| `resyncing` | the resync throws | `resyncing` | wait the backoff, then the whole resync again |
| `retrying` | the reattach attaches them, or they are gone or let go | `attached` | snapshot each one that attached |
| `retrying` | some still will not attach | `retrying` (those) | wait the backoff |
| `retrying` | the reattach throws | `retrying` | wait the backoff |
| any but `disconnected` | the daemon closes | `disconnected` | a pass that was running ends, and its outcome is dropped; a wait in progress is not cut short |
| `attached` | anything but a close | `attached` | nothing |

The keeping loop runs exactly while the phase is not `attached`; leaving
`attached` starts it. The backoff starts again at 1 s after a pass that
attached everything it tried. The table test is in
`apps/host-agent/tests/daemon_keeper.test.ts` ("keeper table").

### Module calls

When the skill module makes a call that needs the service (see "Delivery"),
the host agent relays it:

```json
{ "type": "module_call", "id": "m5", "session": "a1b2", "token": "<call token>", "turn_id": "turn-7", "cause": "autonomous", "call": "speak", "args": { "text": "Done, the tests pass." } }
```

The service answers:

```json
{ "type": "module_reply", "id": "m5", "status": "delivered", "reason": null }
{ "type": "module_reply", "id": "m6", "status": "delivered", "reason": null, "result": { "visible": ["..."] } }
```

`status` is `delivered`, `accepted`, `refused` or `failed`. `turn_id`,
`cause`, and the `turn_id` fields on events are additive; an older host
may omit them. The service checks the token against the session's current call
and, when present, the turn authority. A self-woken call without an authority
is refused, while an old host's ordinary caller turn keeps the existing token
behavior. If no reply arrives in time, or the link is down, the module gets
`failed`. In time is 30 s, or for `speak` the speech deadline and 5 s more
(`SPEAK_REPLY_MARGIN_MS` in `skill_socket.ts`). The service starts its own
speech deadline only when it admits the call, after the frame has crossed the
link, and answers `delivered` once the whole line has played; the margin lets
that answer, not the host agent's clock, decide. A call that cannot
go out because the link's socket is already closing gets `failed` at once.

Each wait on a `speak` has one owner, and each is longer than the one it
waits on, so the service's answer is the one that decides:

| Wait | Owner | Length |
|---|---|---|
| The speech itself | the service (`module_calls.rs`, from admission) | `SWITCHBOARD_SPEECH_DEADLINE_MS`, given to the session in `join_call` |
| The relayed call | the host agent (`speakReplyMs` in `skill_socket.ts`) | the speech deadline and `SPEAK_REPLY_MARGIN_MS` (5 s); sent to the module as the hello's `speak_reply_ms` |
| The socket reply | the skill module (`_call_host_agent`) | the hello's `speak_reply_ms` and `_MARGIN_S` (5 s) |

Only the host agent holds its margin; the module reads the result from the
hello rather than keeping a copy.

### Frames the service cannot read

The service reads frames with serde_json, which refuses three things that
are valid JSON: a string with half of a UTF-16 surrogate pair (`"\ud83d"`,
an emoji cut in two), a number beyond a double (`1e400`), and arrays or
objects nested deeper than 127 levels (serde_json's recursion limit refuses
the 128th; `MAX_FRAME_DEPTH` in `hosts.rs`). This host agent writes only the last
of them: its `JSON.stringify` writes no number beyond a double, and it writes
every lone surrogate as U+FFFD (below). When the whole frame cannot be read,
the service still reads its `type`, `id`, `epoch`, `session` and `call`
(serde skips the other fields without building them) and answers what it
can, at once:

- a `module_call` is refused, its reason naming the fault:

  ```json
  { "type": "module_reply", "id": "m5", "status": "refused", "reason": "this call cannot be read: a string holds half of a UTF-16 surrogate pair" }
  ```

- a `reply` fails its command with `unreadable_reply`;
- any other frame (an `event`, a `snapshot`, a frame without an `id`) has
  nothing to answer by. It is logged at warn with the reason and dropped.

A frame that is read but lacks what it needs (a reply or module call without
an `id`, an event without a `session` or `cursor`) is logged and dropped the
same way. A module call for a session whose listener has gone is refused
`not_on_call`, as one for a session nobody listens to.

The host agent writes every frame well-formed: a lone surrogate in any
string it sends, a value or an object's key (daemon text, a saved session's
first message, a tool's `args` and `result` keys, a relayed call's
arguments), goes out as U+FFFD, so the frame is not lost to it. A
clipped tool `args` or `result` preview is cut between whole characters, so
it makes none. The skill module refuses a lone surrogate before sending, so a
relayed call is not changed in practice. It holds a display call to the depth
the service reads, too (`_MAX_FRAME_DEPTH`, the same number as
`MAX_FRAME_DEPTH`; `scripts/check_hygiene.mjs` keeps them equal): the request
line it writes nests the call's `args` one level in, as the host agent's
`module_call` frame does, so a line within the cap is a frame within it.

Going the other way, the host agent logs and drops a service frame that is
not a JSON object, a `module_reply` whose call is no longer waiting (it
already failed at its deadline), and a frame of no known type. A
`module_reply` with no known `status` fails its call.

## Skill socket

A Unix socket at `~/.cache/switchboard/host-agent.sock` (directory 0700,
socket 0600). JSON lines: the module writes one request per line and reads
one reply line; the host agent never pushes. A connection may carry several
requests; they are answered in order. A request line is at most 13 MiB: the
largest display action (an image, at most 12 MiB) with room for its envelope,
and safely under the host link's 16 MiB frame, which the relayed call is
re-wrapped in. A line ends at `\n` (a `\r` before it is part of the break,
though it counts toward the cap), and its length is counted as its bytes
arrive: a line that passes 13 MiB is answered `refused`, `too_large`, in its
turn, without waiting for its newline. The host agent reads the rest of that
line and drops it as it arrives, so it never holds more than the cap of any
line however long it runs, and the connection ends with the line; lines after
it are not read.

The module writes a request and reads its answer before it writes the next,
so it never has more than one waiting. A client that writes ahead is held to
`MAX_WAITING_REQUESTS` (8) requests read and not yet answered on one
connection, the one being handled included, and to 13 MiB of request text
between them. A line past either bound is answered `refused`, `queue_full`, in
its turn, and the connection ends after it; lines after it are not read. So a
connection holds at most one line's cap of waiting requests and one open line
however it writes.

### Hello

```json
{ "op": "hello", "session_id": "0199...", "depth": 0 }
```

`session_id` is the basename of `RLM_SESSION_DIR`; `depth` is `RLM_DEPTH` as
a number. Replies:

```json
{ "on_call": false }
{ "on_call": true, "token": "<call token>", "persona": "...", "speech_deadline_ms": 25000, "speak_reply_ms": 30000 }
{ "on_call": false, "reason": "subagent" }
```

The last is the reply for any `depth` other than 0. `speak_reply_ms` is how
long the host agent waits for the service's answer to a relayed `speak` on
this call (below, "If no reply arrives in time"); the module waits that and
its own 5 s more. A hello without it, from a host agent older than the field,
makes the module wait for a `speak` as for any other call: 35 s.

### Calls

```json
{ "op": "call", "session_id": "0199...", "depth": 0, "token": "<call token>", "call": "speak", "args": { "text": "..." } }
```

Calls: `speak {text}`, `request_to_speak {message, reason}` (`reason` is
`finished`, `needs_decision` or `problem`), `display {action}`, and
`view {target?}`. For `request_to_speak`, `message` is exactly what the caller
should hear: the actual result, decision question and options, or problem and
need. It is queued and lightly smoothed; it does not ask the caller to bring
the background session forward. A session has at most one request waiting: a
newer one takes the place of the one it already has in the queue, unless that
one is next to be spoken.

Reply: `{status, reason, result?}`, `status` one of `delivered`, `accepted`,
`refused`, `failed`. Checks, in order:

1. `depth` other than 0: `refused`, `subagent`.
2. Unknown `call`: `refused`, `unknown_call`.
3. The session is not tracked, not on a call, or the token is not the
   current call's token: `refused`, `not_on_call`.
4. Delivery by mode (below); a relayed call returns the service's reply.

A request that is not JSON gets `refused`, `bad_request`.

The module checks the call before it connects: a value JSON cannot carry (a
NaN, an infinity, or a string holding half of a surrogate pair) raises in
the agent's code, and nothing is sent. So, naming the field, does a value the
service would read as another: an integer beyond 2^53 (the service and the
page read numbers as doubles, which hold every integer exactly only that far;
one beyond a double's range became `null`), or arrays and objects nested
deeper than the service reads (above).

### Delivery

| Call | `foreground`, `active` | `background` |
|---|---|---|
| `speak` | relayed | `refused`, `caller_away` |
| `request_to_speak` | `refused`, `caller_listening` | relayed |
| `display` | relayed | held until the caller brings the agent forward: every action, applied to a stage of its own under the same caps |
| `view` (no target) | relayed | relayed |
| `view` (target) | relayed | `refused`, `caller_away` |

The host agent refuses what this table refuses for `speak` and
`request_to_speak` itself (`decide()` in `skill_socket.ts`), from the
session's call state. It relays `display` and `view` in every mode, and the
service decides those: it holds a background display (`accepted`, with
`held: true` in the result) and refuses a background `view` with a target.
A refusal reaches the module with its code as `reason` (`caller_away`); the
service's explanation stays in `result.detail`.

`active` currently delivers like `foreground`. A background agent may ask
what the caller sees, not change it: the screen belongs to whoever the caller
is with, and its own displays wait for the promotion (#135). They wait as a
scene, not as one action: each is applied to a projection held for the agent,
a show past the stage caps is refused when it is sent, and the promotion
replays that projection into the cleared stage (#254).
