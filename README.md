# switchboard

The voice front door for the lab. You call the operator; the operator patches
you through to a project's coding agent, running in that project's own
directory on the host that holds the code; that agent hands you back when you
are done.

Deployed to `damocles` (313, 192.168.1.217) by `ansible/roles/damocles`. Do not
edit anything here on the box — it is overwritten on every deploy.

## The call path

```text
browser mic --webm/opus--> /ws --speech-to-text sidecar--> transcript
    --> Switchboard.handle()  ── the active leg is either the operator or a project
    --> reply text --ElevenLabs--> mp3 --> /ws --> playback
```

Two kinds of leg, both a `pi --mode rpc` process driven over stdin/stdout:

| leg | runs | tools | lifetime |
| --- | --- | --- | --- |
| operator | on damocles | `transfer_to_project` only (`--no-builtin-tools`); project catalog is in its system prompt | persistent — it is the home base |
| project | on the host in the registry entry, `cd`'d into that project's directory | its normal coding tools | created on transfer, destroyed on return (never resident at startup) |

## Startup prewarm

Everything a project leg needs from its host is set up once, at startup, by
`apps/backend/src/prewarm.rs`, before the listener opens:

- **SSH masters.** One persistent master connection per host
  (`ControlMaster=yes`, `ControlPersist=no`), with a lock file and control
  socket under `SWITCHBOARD_STATE_DIR/ssh/`. A master another switchboard
  process already holds is adopted rather than duplicated; only the process
  that created a master tears it down. A master that dies is reconnected under
  a new generation.
- **Model catalogs.** `pi --list-models` per host and runtime, at startup and
  then every five minutes; a failed refresh keeps the last good listing.
- **The agent extension.** Staged once to every host that needs it: written
  to a temporary file, checked against its SHA-256, then moved into place. A
  host that cannot take it launches its legs without it; a changed extension
  reaches hosts with the next restart.
- **Prepare commands.** Each project's `prepare` runs once. Its output, exit
  status, or timeout becomes a timestamped report the incoming agent is shown;
  a failure is reported, not retried, and does not block the project.

Project processes are **not** resident at startup; they launch on transfer. A
transfer or redial asks prewarm for a launch plan and starts the process from
it, doing no setup of its own: no SSH handshake, no upload, no prepare, no
model listing. A host prewarm cannot vouch for is a refused transfer, and on a
redial the live leg keeps running.

## Who does the talking

The **operator** never speaks for itself — everything it produces is meant to be
heard, so the switchboard synthesizes its reply directly. No mismatch to fix.

A **project agent** speaks for itself, with the `speak` tool. This is the part
worth understanding: a coding agent writes for a reader — markdown, paths,
diffs — and reading that aloud is the wrong output in the wrong place. Worse,
the switchboard cannot voice a written reply until the turn *settles*, so a
two-minute stretch of tool calls is two minutes of silence, which on a phone
call is indistinguishable from a dropped connection.

So the agent decides what to say and when, mid-turn, and its written output
stays written. `speak` POSTs to this service's `/speak`, which pushes audio
straight to the browser without waiting for anything.

The fallback matters too: if an agent finishes a turn having never called
`speak`, the switchboard voices its written reply rather than leaving the caller
in silence. It knows which happened because `speak` shows up in the same RPC
event stream it already watches. An agent on a host where the tool extension
could not be staged is told the opposite thing in its system prompt — write for
the switchboard to read out — so both paths produce a working call.

`speak` is deliberately **not** MCP. Pi has no built-in MCP because tool
definitions are expensive context; an adapter would add a config file, a
process, and a per-host install. A tool already staged to every host the
switchboard connects to has none of that.

## Showing rather than saying

Some answers are a shape, not a sentence. Project agents push structured
display actions (`show`, `hide`, `say`, `focus`, `clear`) across seven content
types (`chart`, `metric`, `progress`, `diagram`, `document`, `code`, `note`)
to the caller's page mid-turn. These use `POST /display` and the browser's
existing WebSocket, just as `speak` uses `POST /speak`; display output does not
change routing or speech synthesis.

The visual stage is not a permanent empty dashboard panel. It appears when an
artifact exists and collapses completely when it does not. The caller can focus
Visual, Comms, System, or Theater by touch or by asking the agent. A caller's
explicit selection remains pinned until they return to Auto, so an agent cannot
pull the screen away from something they chose to read.

The browser reports its rendered `screen_state` over the WebSocket. Calling the
agent's `view` tool without a target returns the active view, artifact kind and
title, stale status, and browser connection state; calling it with a target
requests the same workspace change exposed by the visible controls. This lets
the agent know what the caller can actually see instead of guessing.

Display actions are strictly validated before acceptance; structured graphs,
tables, and text are sanitized by the browser renderer. The product and layout
contract is in `docs/frontend-command-station-architecture.md`; payload details
are in `docs/display-tool.md` and `docs/visual-channel.md`.

## Who decides where the caller goes

The switchboard does — not the agents. An agent calling `transfer_to_project` or
`return_to_operator` only raises a *signal*: the tool itself does nothing but
acknowledge, and `pbx.rs` picks the call out of pi's `tool_execution_start`
event stream and swings the line over. That means a confused or wedged agent
cannot strand the caller, and every failure path (bad ssh key, wrong `cwd`,
missing agent binary, a leg that dies mid-call) ends with the caller back on the
operator being told what happened, rather than talking into a dead pipe.

For runtimes that cannot load a pi extension, the agent's system prompt tells it
to emit `[[SWITCHBOARD:RETURN]]` instead; `pi_client.rs` treats that line as the
same signal and strips it before anything is spoken.

Project agents get `transfer_to_project` too, so "send me to the other project"
is one hop instead of a round trip through the operator. They cannot read the
registry from a project host, so the projects they may hand the caller to are
named in their system prompt; anything else, they send the caller back and let
the operator resolve it.

Successful transfers are silent: handoff text and model notes are omitted on successful routing paths, and the target project addresses the request immediately without spoken handoff text or greetings. The intro prompt carries the exact original caller transcript, derived intent, project metadata, and any timestamped prepare report snapshot.

The page is relabelled the moment the line swings rather than when the turn
ends, because bringing a leg up means ssh, an agent start and an intro prompt,
and the caller should not spend that looking at the name of whoever they just
left.

## Changing the model mid-call

A caller can ask the agent they are talking to for a different model or thinking
level, and the operator can name one on the way in (`transfer_to_project` takes
`model` and `thinking`). Both go through the same signal mechanism as a
transfer, for a blunter reason than usual: an agent cannot restart itself onto
another model, because the process it would have to replace is the one making
the call. `set_model` acknowledges, `pbx.rs` tears the leg down and brings it
back up.

The conversation survives that restart. Every project leg is started with
`--session-id`, so the replacement process reopens the session file the old one
was writing and picks the call up mid-sentence. Preserving is the default;
`keep_context: false` mints a new id instead, and the agent is told the history
was cleared on purpose so it does not try to recall it.

On a project that runs on another host, keeping the conversation is refused
for now. The switchboard can stop its own `ssh`, but it cannot confirm the pi on
the far side has exited, and two processes writing one session file is worse
than no swap. The live leg keeps running and the caller is told to ask for a
fresh start, which switches without the history. The thinking picker keeps
context, so on such a project it is refused the same way.

What the caller says goes through speech-to-text and then through a model's
guess, so `models.rs` refuses rather than guesses. A name is resolved against
the catalog prewarm listed with `pi --list-models` **on the host the leg runs
on** — providers are configured per box, so asking damocles would answer for the
wrong machine — and a phrase matching two entries comes back as an error naming
both. That is the case worth spending code on: one model id served by two
providers, picked wrong, leaves the caller on the thing they were trying to get
away from with no way to say so. The resolved spec is always provider-qualified
even when the caller was not that specific.

If the catalog cannot be read at all, a provider-qualified spec is passed
through (it is unambiguous by construction) and a bare name is refused. A
thinking suffix such as `provider/model:high` is normalized and retained during
that fallback and on a context-preserving redial. When discovery succeeds, the
picker contains only the provider-qualified entries from that host's catalog;
the current entry is retained even if a refreshed catalog no longer lists it.

A swap is decided before anything is torn down. Every refusal (no project on
the line, swaps turned off, a remote project asked to keep its conversation, a
host prewarm cannot vouch for, a model the catalog does not resolve, the model
already running) is made from the leg the coordinator names and the launch
plan prewarm holds, without the PBX lock, and the live leg keeps running: the
caller hears why, and their next turn reaches the same agent. That holds for the
page's pickers (`POST /model`, `POST /thinking`) and for the agent's own
`set_model` alike. Only a swap that will go ahead cancels the turn in flight,
and only while the caller is still on the leg it was decided for; a caller who
has moved on by then, or moves before the swap reaches the PBX, stays where
they went, and the picker is answered 409.

The operator is never swappable. It is where a failed swap lands the caller, so
it always answers on `switchboard_operator_model`. Set
`switchboard_model_swaps: false` in the role to turn the whole thing off.

## Thinking levels

Every leg is started at an explicit level. `switchboard_agent_thinking` supplies
one whenever the caller did not name their own, because pi does not report what
its own default would have been — an unpinned leg runs at a level nobody can
name, and a page that says "default" is telling you nothing you can act on.

Asking is not the same as getting. A model whose `thinkingLevelMap` has holes
gets clamped to a level it does have, silently, inside the session — so the
level on the command line can be a level nothing is running at. The agent
extension therefore reports `pi.getThinkingLevel()` back to `POST /leg-state`
when its session starts and whenever the level changes under it, and that
reported value is what the page shows. Until a leg reports, the page marks the
level as requested rather than stating it.

`POST /thinking` (the picker on the page) sets the level for the rest of the
process and re-dials the live project leg onto it, keeping the session file. The
level is kept for the next project call even when that re-dial is refused. The
operator is never re-dialled for this; its level is a deployed setting.

Project callbacks carry `SWITCHBOARD_SESSION_TOKEN`, an opaque token freshly
created for each process and distinct from the persistent Pi session ID. It
rejects stale speech, display, and thinking callbacks after a redial; it is a
correlation value, not authentication. A failed `/speak` delivery is reported
as an extension tool error, so the written reply remains eligible for fallback
synthesis rather than being suppressed by a tool-start event.

## Connecting without the operator

`POST /connect` (`{"project": "..."}`, or `"operator"` to come back) puts the
caller straight onto a project from the page. The operator is a router, not a
gate: when the caller already knows where they want to be, saying it out loud
and waiting to be understood is pure overhead. Any live leg is dropped first,
without the turn lock, for the same reason `/hangup` does not take it.

## Getting unstuck

`POST /hangup`, wired to the button on the page, drops the project leg and puts
the caller back on the operator. Every other way back runs through an agent
deciding to let go, which is no use when the agent is the problem — a leg on a
model that cannot hold a thread, a turn that will not settle. So this one asks
nobody, and deliberately does not take the turn lock: a rescue that waits for
the thing it is rescuing you from is not a rescue. A turn still in flight when
the button is pressed has its result discarded, because acting on it would swing
the route straight back.

The operator route remains the home base. If a page control reaches the service
while the operator process itself is wedged, that process is discarded and
recreated on the next utterance; the route still remains `operator`. The
transcript records what was hung up on: the project leg by name (including
one still in its intro once it has shown life), a leg that had not yet
picked up, or the operator's turn.

## When nobody says anything

`SWITCHBOARD_IDLE_TIMEOUT` (an hour by default, `switchboard_idle_timeout` in
the role) drops a project leg the caller has gone silent on and puts them back
on the operator. A call that is never ended otherwise holds an agent process and
an ssh connection open on someone else's box for as long as this service runs.
Silence is measured from the last sign of life on the line: a clip arriving, a
turn starting or ending, a steer, or a spoken reply, so a long-running turn
never counts against the caller. Nothing is synthesized when it fires — by
definition nobody is listening — the note only appears in the transcript, and
the operator is told why the line is free when they come back.

## Adding a project

Edit `switchboard_projects` in `ansible/roles/damocles/defaults/main.yml` and
open a PR. The deploy re-renders `/etc/switchboard/projects.json`, which the
service loads into the operator's system-prompt catalog and uses for routing,
so the operator and switchboard cannot disagree. Aliases are matched against
a speech-to-text transcript, so be generous with them.

A project host needs three things, none of which this repo can do for hosts it
does not manage:

1. damocles's pubkey in the ssh user's `authorized_keys`
2. the agent runtime the entry names (`pi`) installed and authenticated there
3. the `cwd` to actually exist

The switchboard stages its own tools (`speak`, `display`, `return_to_operator`,
and the rest of `extensions/agent-switchboard.ts`) into
`~/.cache/switchboard/extensions/` on the host at startup, so that part needs
no setup.

If the agent binary is installed per-user (`~/.local/bin/pi` is the common
case), give `runtime` the **absolute path**. A non-interactive ssh session does
not get the PATH you see when you log in by hand, so a bare `pi` works when you
test it manually and then fails with "command not found" for the switchboard.

## Files

| path | what it is |
| --- | --- |
| `apps/backend/src/main.rs` | composition root, and `Config`: the one reader of the environment |
| `apps/backend/src/api.rs` | HTTP and WebSocket endpoints, turn and speech workers, delivery to the browser |
| `apps/backend/src/lifecycle.rs` | the coordinator: call identity, the current route and leg, phases, candidate legs, idle clock, status |
| `apps/backend/src/pbx.rs` | routing: transfers, returns, redials, rescue, and the agent processes |
| `apps/backend/src/prewarm.rs` | startup setup per host and project, and launch plans |
| `apps/backend/src/pi_client.rs` | the pi RPC protocol — one turn in, text and signals out — and SSH commands |
| `apps/backend/src/models.rs` | model catalogs and spoken model/thinking resolution |
| `apps/backend/src/registry.rs` | the project registry and spoken-name resolution |
| `apps/backend/src/audio.rs` | speech-to-text sidecar, ElevenLabs, and reply-length shaping |
| `apps/backend/src/visual_protocol.rs` | validation of display actions |
| `apps/backend/src/protocol.rs` | every WebSocket message the service sends the browser; its browser half is `apps/frontend/src/protocol.ts` |
| `apps/backend/src/history.rs` | the transcript kept for page reloads |
| `apps/backend/tests/` | Rust tests, one file per source module |
| `apps/frontend/src/` | V17.2 React presentation and its call runtime |
| `apps/frontend/src/runtime/` | the browser's side of a call: backend WebSocket, push-to-talk, playback, hands-free wiring |
| `apps/frontend/src/hands_free.ts` | hands-free controller, real wake adapter, and separate VAD endpointing |
| `apps/frontend/tests/` | browser, display, and pi-extension tests |
| `static/index.html`, `static/v17-assets/`, `static/vad-worklet.js` | committed deterministic browser build output |
| `static/openwakeword/` | same-origin Hey Jarvis ONNX, wrapper, and ONNX Runtime WASM assets |
| `extensions/*.ts` | the pi extensions: `operator-switchboard.ts` for the operator, `agent-switchboard.ts` for project legs |
| `docs/environment.md` | every environment variable the service reads, and what it passes to agents |
| `docs/architecture.md` | ownership boundaries and the rules for where new behavior goes |
| `docs/display-tool.md` | the `display` tool: payload, operations, layout, and composition |
| `docs/hands-free.md` | hands-free lifecycle, asset provenance, and license obligations |

## The environment contract

`docs/environment.md` lists every variable the service reads and everything it
passes to project legs; it is the interface with the homelab deployment.

Two contracts there need more than a line. Speech-to-text is a sidecar:
`SWITCHBOARD_STT_COMMAND` receives complete WebM bytes on stdin and writes the
transcript to stdout. Deployments may additionally set
`SWITCHBOARD_STT_STREAM_COMMAND` to a long-lived worker. It receives
length-prefixed frames (kind byte, big-endian `u32` payload length, payload),
starts with a JSONL `{"type":"ready"}` line, and emits bounded JSONL
`partial`/`final` records; partials are logged, and only a final result
becomes a turn. A chunk payload starts with an id length byte, the
UTF-8 clip id, big-endian generation and sequence numbers, then the WebM bytes,
so concurrent clips remain attributable. Streaming is selected only for
WebM/Opus clients after the WebSocket hello handshake; unavailable or
backpressured workers explicitly fall back to the complete-clip contract.

`SWITCHBOARD_SPEECH_DEADLINE_MS` bounds one synthesized utterance, for `/speak`
and for replies alike, and the project extension aborts at the same deadline;
the service passes the value to every leg so the two cannot disagree.

## Building and testing

```bash
npm ci
npm test                     # builds static/, then browser, display, and extension tests
git diff --exit-code -- static
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

These are the CI gates (`.github/workflows/ci.yml`). `static/` is committed
build output, so a change that alters it commits the rebuild too.

`build.rs` stamps the binary with the commit it was built from, logged at
startup as `git=` and reported by `/healthz` as `git`. It takes
`SWITCHBOARD_GIT_SHA` from the build environment when set (trimmed; blank means
unset; anything that is not a commit or tag name fails the build), else
`git describe --always --dirty --abbrev=12`, else `unknown`. The homelab
builder compiles a `git archive` of the pin, which has no `.git`, so it passes
the pinned commit in that variable. It is a build-time input, not part of the
env file, but under `AGENTS.md` it is interface all the same: renaming it or
changing what it accepts needs a homelab PR.

PBX mutation is serialized, while live status, agent callbacks, steering,
forced page rescue, and the pickers' swap decisions bypass that lock through
bounded shared controls. The forced-rescue path, and a picker refusal that
leaves the leg alone, are covered under a deliberately wedged turn in the Rust
tests. Fake pi, SSH, TTS, and STT paths are exercised without network access.
Unit tests cannot establish microphone, model, or remote-host behavior; check
those on the deployment host after a pin bump.

## Operating it

```bash
systemctl status switchboard
journalctl -u switchboard -f          # every transcript, route change and signal
curl -s localhost:8765/healthz | jq   # commit, model, TTS config, current route
```

The browser page is `https://switchboard.home.arpa` (via caddy). It has to be
https: browsers only grant microphone access on a secure context, so hitting
`http://192.168.1.217:8765` directly will load the page and then fail to record.

Restarting drops whatever call is in progress and repeats the startup prewarm.
Speech-to-text runs in its own service (`switchboard-stt`) and is not restarted
with it.
