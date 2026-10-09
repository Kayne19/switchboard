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

Two kinds of leg:

| leg | runs | tools | lifetime |
| --- | --- | --- | --- |
| operator | a local `pi --mode rpc` process on damocles, driven over stdin/stdout | `route` only (`--no-builtin-tools`); the shared voice block, persona and project catalog are appended to its system prompt | persistent — it is the home base |
| project | a session on the prime-agent daemon of the host in the registry entry, in that project's directory, reached through that host's host agent over the host link (`/host`, `docs/host-link.md`) | its normal coding tools, plus the `switchboard` skill module | created on transfer, ended on return (never resident at startup) |

The service opens no connection to a project host. Each host agent dials in to
`/host` with its own token, and every command for a project leg (create,
prompt, steer, abort, kill, model and thinking changes) goes over that link.

## Startup prewarm

Everything a project leg needs from its host is set up ahead of any call by
`apps/backend/src/prewarm.rs`:

- **Model catalogs.** The host agent's `list_models`, each time a host links
  and then every five minutes; a failed refresh keeps the last good listing.
- **Prepare commands.** Each project's `prepare` runs once, through the host
  agent's `run_prepare`, as soon as its host links. Its output, exit status, or
  timeout becomes a timestamped report the incoming agent is shown; a failure
  is reported, not retried, and does not block the project. A prepare cut off
  by a lost link runs again on the next link.

Prewarm runs this as each host links, not before the listener opens: the host
agents dial in to the listener. Nothing is copied to a host. The `switchboard`
skill module reaches each host with the host-agent installer
(`docs/host-agent.md`).

Project sessions are **not** resident at startup; they start on transfer. A
transfer or redial asks prewarm for a launch plan and starts the session from
it, doing no setup of its own: no prepare, no model listing. A project with no
`host`, or whose host is not connected, is a refused transfer, and on a redial
the live leg keeps running.

## Who does the talking

The **operator** never speaks for itself — everything it produces is meant to be
heard, so the switchboard synthesizes its reply directly. No mismatch to fix.

A **project agent** speaks for itself, with the `speak` tool. This is the part
worth understanding: a coding agent writes for a reader — markdown, paths,
diffs — and reading that aloud is the wrong output in the wrong place. A
written reply is kept for the transcript and screen when the turn *settles*;
it is not synthesized, so a two-minute stretch of tool calls is simply a
silent stretch on the phone call.

So the agent decides what to say and when, mid-turn, and its written output
stays written. `switchboard.speak` (the Python skill module) sends the line
through the host agent to this service as a `module_call` on the host link,
and the service pushes audio straight to the browser without waiting for
anything. If the agent does not call `speak`, its written reply stays in the
transcript and on screen without being synthesized. A spoken line reaches the
live box when its audio starts to play, not when its text arrives: each spoken
line names the audio utterance that voices it. The live box keeps a short log of the
lines heard, the newest at the top of the box with blank space below it, so a
caller who stepped away can scroll back and catch up. A history snapshot does not
guess which agent lines were spoken, so the live box waits for the next spoken
line after a reconnect. Reply and history frames carry the same voiced flag, so
a reconnect restores the last voiced line without putting written text on the
live surface.

The caller hears **one person** for the whole call. A code-owned block,
`CALL_VOICE` in `prompts.rs`, says how anyone on the call talks: one voice, say
less, show rather than tell, bad news straight. The persona from
`SWITCHBOARD_PERSONA` follows it. The operator's system prompt, the routing
utility's system prompt and every project voice brief carry the same two
texts, so the front desk and the project work sound like the same person, and
each text has one source.

`speak` is deliberately **not** MCP. Pi has no built-in MCP because tool
definitions are expensive context; an adapter would add a config file, a
process, and a per-host install. A Python module in the agent's own kernel
keeps tool definitions out of every request, and can combine `speak` and
`display` in one cell.

## Showing rather than saying

Some answers are a shape, not a sentence. Project agents push structured
display actions (`show`, `hide`, `say`, `focus`, `clear`) across fourteen content
types (`chart`, `metric`, `progress`, `diagram`, `document`, `code`, `table`,
`note`, `image`, and the personal-assistant `calendar`, `tasks`, `timer`,
`weather`, `inbox`)
to the caller's page mid-turn. They arrive as module calls over the host link,
just as `speak` does, and reach the page over the browser's existing
WebSocket; display output does not change routing or speech synthesis.

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

The switchboard does — not the agents. Jev classifies each utterance first
(`docs/jev-routing.md`), and the routing utility gives a second opinion when
Jev is unsure or sees several projects. The operator's `route` tool only raises
a *signal*: the tool itself does nothing but acknowledge, and the switchboard
(`decisions.rs`), which picks the call out of pi's `tool_execution_start` event
stream, swings the line over. That means a confused or wedged agent cannot strand the caller, and every
failure path (a host that is not connected, wrong `cwd`, a session that fails
to start, a leg that dies mid-call) ends with the caller back on the operator
being told what happened, rather than talking into a dead pipe.

Project agents have no routing tools. Moving the caller, model changes and
hanging up happen before their turn, and the voice brief says so. When the
caller names another project, the switchboard takes them there.

Successful transfers are silent: the target project picks up the request
without a greeting or spoken handoff. The intro prompt carries the caller's
exact words, the derived intent when there is one, the project id and
description, and a one-line startup check when a prepare report exists.

The page is relabelled the moment the line swings rather than when the turn
ends, because bringing a leg up means a session start and an intro prompt,
and the caller should not spend that looking at the name of whoever they just
left.

## Changing the model mid-call

A caller changes the model or thinking level of the project they are on with
the page's pickers (`POST /model`, `POST /thinking`). Asking for it out loud
reaches the operator, which points them to the picker. `redial.rs` decides and
makes the change.

The conversation survives the change. A change that keeps the context is made
on the live session: `set_model` and `set_thinking` over the host link, and
the session keeps its history. Keeping is the default; `keep_context: false`
ends the session and creates a new one, and the agent is told the history was
cleared on purpose so it does not try to recall it.

What the caller says goes through speech-to-text and then through a model's
guess, so `models.rs` refuses rather than guesses. A bare name is resolved
against the catalog prewarm listed through the host agent **on the host the leg
runs on** — providers are configured per box, so asking damocles would answer
for the wrong machine — and a phrase matching two entries comes back as an
error naming both. A provider-qualified model is accepted when its provider is
listed even if that catalog snapshot lacks the model id; the daemon is
authoritative for whether that id exists. An unknown provider is still refused.
That is the case worth spending code on: one model id served by two providers,
picked wrong, leaves the caller on the thing they were trying to get away from
with no way to say so. The resolved spec is always provider-qualified even when
the caller was not that specific.

If the catalog cannot be read at all, a provider-qualified spec is passed
through (it is unambiguous by construction) and a bare name is refused. A
thinking suffix such as `provider/model:high` is normalized and retained during
that fallback and on a context-preserving redial. When discovery succeeds, the
picker contains only the provider-qualified entries from that host's catalog;
the current entry is retained even if a refreshed catalog no longer lists it.

A swap is decided before anything is torn down. Every refusal (no project on
the line, swaps turned off, a host that is not connected, a bare or
unknown-provider model the catalog does not resolve, the model already running)
is made from the leg the coordinator names and the launch plan prewarm holds,
without the PBX lock, and the live leg keeps running: the caller hears why, and
their next turn reaches the same agent. Only a swap that will go ahead cancels
the turn in flight, and only while the caller is still on the leg it was
decided for; a caller who has moved on by then, or moves before the swap
reaches the PBX, stays where they went, and the picker is answered 409.

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
level asked for can be a level nothing is running at. The page therefore shows
the level the host reports for the session: the host agent reads the
effective level from the daemon and sends it with the reply to
`set_thinking` and in session `state` events (`docs/host-link.md`). Until the
host reports, the page marks the level as requested rather than stating it.

`POST /thinking` (the picker on the page) sets the level for the rest of the
process and switches the live project session onto it, keeping its history.
The level is kept for the next project call even when that switch is refused. The
operator is never re-dialled for this; its level is a deployed setting.

Each project leg joins the call with a fresh call token (`join_call`),
distinct from the session's id. Module calls carry it, and a stale one is
refused, so speech or a display from a leg the caller has left since is not
taken as the current leg's; it is a correlation value, not authentication (the
host link's token is). A failed speech delivery is returned to
the agent as a `refused` or `failed` result. The agent can try again when the
leg is live; its written reply remains in the transcript and on screen.

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

The switchboard does not drop a silent call. A project session nobody uses is
ended by prime-agent's own idle eviction on its host, and the caller stays on
the line until they hang up or are handed back.

## Context

A project agent manages its own context, and the voice brief is what tells it
how. It keeps its context lean by giving hands-on work to subagents and keeping
only their results. When a piece of work is finished and nothing for it is
still running, it writes down what should outlast it, in an issue, a doc or a
commit, and then compacts. After a compaction it searches its own conversation
log instead of guessing.

Sessions do not carry memory between calls. An idle session is ended on its
host, and the next call starts fresh, so what persists is what was written to
issues, docs and commits. The llm-wiki brain holds engineering taste and
decisions; it is not session memory. This lives in the brief on purpose: the
behaviour belongs to the switchboard, not to one harness's memory feature, so
it stays the same if the harness changes.

## Adding a project

Edit `switchboard_projects` in `ansible/roles/damocles/defaults/main.yml` and
open a PR. The deploy re-renders `/etc/switchboard/projects.json`, which the
service loads into the operator's system-prompt catalog and uses for routing,
so the operator and switchboard cannot disagree. Aliases are matched against
a speech-to-text transcript, so be generous with them. An entry carries `id`,
`description`, `aliases`, `host`, `cwd`, `model` and `prepare`; `host` is the
id of a host agent and is required.

A project host needs three things, none of which this repo can do for hosts it
does not manage:

1. the host agent and the prime-agent daemon installed (below), with the
   host's token in the service's host tokens file (`docs/environment.md`)
2. prime-agent authenticated there for the models the project uses
3. the `cwd` to actually exist

The project agent's tools (`speak`, `request_to_speak`, `display` and `view`)
are the `switchboard` Python skill module in `skills/switchboard/`. It works
only during a call, through the host agent's local skill socket
(`docs/host-link.md`, "Skill socket"); every call returns a result and prints
one line, and a refusal or failure never raises.

Each project host also runs the host agent, and the shared prime-agent
daemon, under systemd user units. One command installs or redeploys both,
with the skill, from a checkout of the pinned commit:
`node apps/host-agent/install.mjs --host-id <id> --token-file <path>`.
`docs/host-agent.md` ("Install and redeploy") has the flags, how to add a
container, and the post-deploy checklist.

## Files

| path | what it is |
| --- | --- |
| `apps/backend/src/main.rs` | composition root, and `Config`: the one reader of the environment |
| `apps/backend/src/api.rs` | the HTTP router, `/healthz`, and the debug listener's router |
| `apps/backend/src/app_state.rs` | the state every handler and worker shares, its construction, the workers, shutdown |
| `apps/backend/src/browser.rs` | the caller page's WebSocket: snapshot, incoming frames, delivery to the browser |
| `apps/backend/src/page_controls.rs` | the page's HTTP controls (connect, model, thinking, hangup) and the rescue they start with |
| `apps/backend/src/module_calls.rs` | a project session's `speak`, `request_to_speak`, `display` and `view`, and their admission |
| `apps/backend/src/caller_input.rs` | clips, streamed clips, typed turns, and transcription |
| `apps/backend/src/turns.rs` | routing a transcript, the turn worker, host-reported turns |
| `apps/backend/src/speech.rs` | the speech worker, continuity, reply voice, and the floor release |
| `apps/backend/src/delivery.rs` | ordered browser delivery: the event envelope, per-connection framing, and the audio queue |
| `apps/backend/src/display.rs` | the stage projection a reconnecting browser replays, and the gate it sits behind |
| `apps/backend/src/floor.rs` | the speech floor: the one owner of background agents' requests to speak and their release order |
| `apps/backend/src/leg_announcer.rs` | announcing a new leg to the browser |
| `apps/backend/src/lifecycle.rs` | the coordinator: call identity, the current route and leg, phases, candidate legs, status |
| `apps/backend/src/pbx.rs` | the switchboard: its state, construction and callbacks, and the types its files share |
| `apps/backend/src/decisions.rs` | what the switchboard does with a routed line: continue, transfer, split, take over, stop, or the operator |
| `apps/backend/src/leg_transitions.rs` | transfers, promotions, takeovers, returns, hangups and stops, all committed one way |
| `apps/backend/src/redial.rs` | model and thinking changes: deciding them, then making them |
| `apps/backend/src/residents.rs` | project agents kept running in the background |
| `apps/backend/src/operator.rs` | the operator's pi process and the routing utility |
| `apps/backend/src/routing_view.rs` | what routing reads without the switchboard's lock |
| `apps/backend/src/prompts.rs` | the call's prompt text: voice block, voice brief, notices, intro |
| `apps/backend/src/reply.rs` | the reply the switchboard hands back for a line |
| `apps/backend/src/router.rs` | Jev-backed routing policy for a caller line, and the compact call summary it reads |
| `apps/backend/src/jev.rs` | typed client for the hosted Jev endpoint; the key is read at request time and never retained |
| `apps/backend/src/hosts.rs` | the host link: host agents dialling in on `/host`, their commands, events and module calls |
| `apps/backend/src/prewarm.rs` | setup per host and project as each host links, and launch plans |
| `apps/backend/src/pi_client.rs` | the operator's pi RPC process, and project sessions over the host link — one turn in, text and signals out |
| `apps/backend/src/models.rs` | model catalogs and spoken model/thinking resolution |
| `apps/backend/src/registry.rs` | the project registry and spoken-name resolution |
| `apps/backend/src/audio.rs` | speech-to-text sidecar, ElevenLabs, and reply-length shaping |
| `apps/backend/src/visual_protocol.rs` | validation of display actions |
| `apps/backend/src/protocol.rs` | every WebSocket message the service sends the browser, and every command the browser sends it; its browser half is `apps/frontend/src/protocol.ts` |
| `apps/backend/src/history.rs` | the transcript kept for page reloads |
| `apps/backend/src/debug.rs` | the optional read-only debug page: bounded event and log rings, the debug listener and its WebSocket (`docs/debug-page.md`) |
| `apps/backend/tests/` | Rust tests, one file per source module |
| `apps/frontend/src/` | V17.2 React presentation and its call runtime |
| `apps/frontend/src/runtime/` | the browser's side of a call: backend WebSocket, push-to-talk, playback, hands-free wiring |
| `apps/frontend/src/hands_free.ts` | hands-free controller, with the wake adapter (`wake_detector.ts`), the Silero speech endpointer (`speech_endpoint.ts`), and the one ONNX Runtime queue both run through (`inference_queue.ts`) beside it |
| `apps/frontend/tests/` | browser, display, and operator-extension tests |
| `static/index.html`, `static/v17-assets/`, `static/vad-worklet.js` | committed deterministic browser build output |
| `static/openwakeword/` | same-origin wake-word ONNX models, wrapper, and ONNX Runtime WASM assets |
| `static-debug/` | committed debug-page build output (`index.html`, `debug.js`, `debug.css`); embedded in the binary and served only by the debug listener (`docs/debug-page.md`) |
| `extensions/operator-switchboard.ts` | the operator's pi extension |
| `skills/switchboard/` | the `switchboard` Python skill module project agents use to reach the caller, and its tests |
| `training/wake-words/` | the two wake-word models the page listens for, their openWakeWord training configs and scripts (`docs/wake-word-training.md`) |
| `apps/host-agent/install.mjs` | installs or redeploys the host agent, the skill and the two systemd user units on a project host |
| `docs/environment.md` | every environment variable the service reads, and what project sessions are given |
| `docs/architecture.md` | ownership boundaries and the rules for where new behavior goes |
| `docs/display-tool.md` | the `display` tool: payload, operations, layout, and composition |
| `docs/hands-free.md` | hands-free lifecycle, asset provenance, and license obligations |
| `docs/ipad.md` | the iPad (WebKit) as a first-class target: what CI checks in WebKit, what it cannot, engine-specific code, and the device checklist before a pin bump |
| `docs/wake-word-training.md` | how the two wake-word models are trained, measured, and licensed |

## The environment contract

`docs/environment.md` lists every variable the service reads and what project
sessions are given when they join a call; it is the interface with the homelab
deployment.

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

`SWITCHBOARD_SPEECH_DEADLINE_MS` bounds one synthesized utterance, for an
agent's `speak` and for replies alike. The skill module waits for the speech deadline the host
agent gives it with the call token, so the two cannot disagree.

## Building and testing

```bash
npm ci
npm test                     # builds static/ and static-debug/, then skill module, host agent, browser, display, and extension tests, and the no-SSH check
git diff --exit-code -- static static-debug
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

These are the CI gates (`.github/workflows/ci.yml`). `static/` and
`static-debug/` are committed build output, so a change that alters them
commits the rebuild too. The browser unit tests need Node 22.19 or later
(their time budgets read the thread's CPU time, `process.threadCpuUsage`);
the host agent itself runs on 22.18.

`build.rs` stamps the binary with the commit it was built from, logged at
startup as `git=` and reported by `/healthz` as `git`. It takes
`SWITCHBOARD_GIT_SHA` from the build environment when set (trimmed; blank means
unset; anything that is not a commit or tag name fails the build), else
`git describe --always --dirty --abbrev=12`, else `unknown`. The homelab
builder compiles a `git archive` of the pin, which has no `.git`, so it passes
the pinned commit in that variable. It is a build-time input, not part of the
env file, but under `AGENTS.md` it is interface all the same: renaming it or
changing what it accepts needs a homelab PR.

PBX mutation is serialized, while live status, module calls, steering,
forced page rescue, and the pickers' swap decisions bypass that lock through
bounded shared controls. The forced-rescue path, and a picker refusal that
leaves the leg alone, are covered under a deliberately wedged turn in the Rust
tests. A fake pi for the operator, an in-process fake host agent for project
legs, and fake TTS and STT paths are exercised without network access.
Unit tests cannot establish microphone, model, or host behavior; check
those on the deployment host after a pin bump.

## Operating it

```bash
systemctl status switchboard
journalctl -u switchboard -f          # transcriptions, turns, route changes, controls, module calls, speech
curl -s localhost:8765/healthz | jq   # commit, which of STT, streaming STT and TTS are configured, route, model, projects, hosts
```

A log line carries the context it happened in as a span.
`ws{connection=3 joined_generation=5}` marks what one browser tab sent and the
work it started, so two tabs can be told apart. `http{endpoint="/hangup"}`
marks a page control, and `module_call{call="speak"}` an agent's module call,
from arrival to outcome, which is either done or the refusal and its reason;
`display` adds the action's `op`, `kind` and `id`. `turn{clip=...}` follows a turn through the PBX, the agent and the
synthesis of its reply, and `stt{clip=...}` the speech-to-text sidecar run.

A sidecar that exits unsuccessfully is logged with the end of its stderr. The
streaming worker logs becoming ready, stopping and restarting, with its exit
status and stderr. An ElevenLabs request is logged by voice, model and
character count, with its HTTP status and latency. The API key and the words
spoken are never logged, and neither is display content, only its size and
kind. `SWITCHBOARD_LOG=switchboard=debug,warn` adds each sidecar run and TTS
request as it starts.

The browser page is `https://switchboard.home.arpa` (via caddy). It has to be
https: browsers only grant microphone access on a secure context, so hitting
`http://192.168.1.217:8765` directly will load the page and then fail to record.
On a page that is not a secure origin WebKit (Safari, and so every browser on
an iPad) leaves `navigator.mediaDevices` undefined, so the page now answers a
tap on Damocles with "No microphone on this page: open it over https, not by
address" instead of recording nothing. Every clip the service accepts is
logged with the mime its browser recorded it as (`clip arrived`), which is
how the journal says whether a caller's browser sent `audio/webm;codecs=opus`
or the `audio/mp4` every iPad browser records.

Restarting drops whatever call is in progress and repeats the startup prewarm.
Speech-to-text runs in its own service (`switchboard-stt`) and is not restarted
with it.
