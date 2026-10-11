# Switchboard architecture doctrine

This document defines the control boundaries that keep Switchboard coherent as
it grows. It is a practical Ports and Adapters architecture with an explicit
call/session lifecycle. It is not a promise that every existing module is
perfectly isolated; it is the rule for where new behavior belongs.

Switchboard is the voice front door for a fleet of coding agents. A caller
speaks to an operator, the operator routes the caller to a project agent in
that project's own directory, and the agent hands the caller back when its
work is done.

## Purpose

The service should be:

- explicit instead of magical
- lifecycle-driven instead of callback-driven
- voice-native without making audio own routing
- provider-replaceable without rewriting call control
- observable instead of opaque
- safe under reconnects, cancellation, stale results, and failed hosts

The architecture should make it easy to answer:

- Which leg owns the caller right now?
- Which project, host, process, and session are active?
- Which generation of work is still current?
- Why did the caller move, return, or fall back?
- Which audio producer and browser connection handled a turn?
- Which deployment contract enabled the behavior?

If a feature makes those questions harder to answer, it belongs at the wrong
boundary or needs an explicit event/state transition.

## System shape

```text
browser mic / page controls
          |
          v
  WebSocket and HTTP adapters: api.rs (router, /healthz), browser.rs (/ws),
  page_controls.rs (page HTTP controls), module_calls.rs (/host module calls)
          |
          v
  application coordination: app_state.rs (shared state, workers, shutdown),
  caller_input.rs (clips, streams, typed turns), turns.rs (routing, turn
  dispatch), host_turns.rs (host-reported turns), speech.rs (the speech
  worker and reply voice),
  floor_hooks.rs (the floor's gate, rewrite and release hooks),
  leg_announcer.rs (a new leg's announcement and scene reset)
          |
          +--> lifecycle.rs: the coordinator -- call identity, the current
          |       route and leg, phases, freshness, the status; the call
          |       line it writes (call_line.rs)
          |
          +--> pbx.rs: the Switchboard -- leg lifecycle and what is behind
          |       each leg, one concern per file: decisions.rs (what a line's
          |       Jev decision does), leg_transitions.rs (legs on and off the
          |       line), redial.rs (model/thinking changes), residents.rs
          |       (background agents), operator.rs (operator and utility
          |       processes), routing_view.rs (routing's lock-free view),
          |       prompts.rs, reply.rs
          |       |
          |       +--> operator Pi process (local)
          |       +--> project session on a host's prime-agent daemon,
          |            started from a prewarm plan
          |
          +--> hosts.rs: the host link -- host agents dial in on /host
          |       (commands, session events, module calls)
          |
          +--> prewarm.rs: setup per host and project as each host links
          |       (model catalogs, prepare)
          |
          +--> audio.rs: STT/TTS ports and adapters
          |       |
          |       +--> STT command or long-lived STT worker
          |       +--> ElevenLabs or local TTS transport
          |
          +--> display.rs: the stage projection and its confirmation gate
          |
          +--> delivery.rs: ordered per-connection delivery and the audio queue
          |
          +--> history / registry / models / visual_protocol
          |
          +--> protocol.rs: every message the service sends the browser,
          |       and every command the browser sends it
          |
          +--> debug.rs: the read-only debug bus, its log copy, and the
                  debug listener's router (docs/debug-page.md)

apps/backend/ ------- the Rust service (src/) and its tests (tests/)
apps/frontend/ ------ browser: call runtime (socket, capture, playback) and rendering
static/ ------------- committed browser build output
static-debug/ ------- committed debug-page build output, embedded in the binary
apps/host-agent/ ---- the host agent on each project host, and its installer
extensions/ --------- the operator's Pi-side tool adapter
skills/switchboard/ - the Python skill module project agents reach the caller with
homelab ------------- deployment, secrets, registry, persona, systemd
```

The dependency direction is intentional:

- external transports enter through adapters
- application code owns lifecycle and policy
- agent processes do reasoning and tool use
- browsers render and capture but do not own authority
- deployment supplies contracts but is not hidden inside the application

### Jev utterance routing

`jev.rs` is the typed HTTP adapter for TypeSafe System One. `router.rs` owns
one routing decision per final transcript: it builds the named call summary,
asks the fixed action/target/current-agent/freshness/multi-target questions,
and applies the confidence thresholds from `Config`. The summary drops its
oldest conversation turns first when the configured budget would be exceeded.
It also contains only live, top-level desk sessions whose folders exactly match
registered projects; the PBX attaches one only after rechecking that no
service-created agent is live. A timeout, malformed response, or uncertain
decision goes through the existing operator LLM path. The PBX applies a
confident decision; project agents and the operator transfer tool do not
independently choose the route. The Jev key is read from the configured secret
file and never appears in logs or errors.

## Core rules

### 1. Switchboard owns the call lifecycle

The switchboard and the coordinator (`lifecycle.rs`) own the call. The
switchboard is the `Switchboard` in `apps/backend/src/pbx.rs`, which holds
the struct, its construction and callbacks; its methods sit with their concern
in `decisions.rs`, `leg_transitions.rs`, `operator.rs`, `prompts.rs`,
`redial.rs`, `reply.rs`, `residents.rs` and `routing_view.rs` (every
`impl Switchboard` block outside `pbx.rs`), all one owner of the same state.
The coordinator owns which leg is on the line (route, project, model, session,
thinking, catalog) and builds the status from it alone; the PBX owns the
processes and changes the leg only through the coordinator's named transitions
(`begin_candidate`, `adopt_candidate`, `rollback_startup`,
`return_to_operator`). Every transition that brings a project leg up (a
transfer, a background promotion, a takeover, a redial) holds one `Startup`
(`leg_transitions.rs`) from the candidate it stages until it commits the leg
or abandons it, so each takes the same steps in the same order. A
rescue's quiet ends in `settle`, which takes the token the rescue returned
(every page control on its way out), or `settle_at` for a reply delivered
at that generation; a status publication settles nothing. A model or thinking redial is decided before
anything is torn down: `RedialPlanner` (`redial.rs`) makes every refusal from the
coordinator's leg and prewarm's launch plan, without the PBX lock, so a refused
page swap never rescues the live leg; `Switchboard::redial` runs a plan only
while the leg it was made for is still on the line, and the PBX acts on its
project session for that leg only while the session is that project's
(`agent_on_the_line`). Between them they own:

- operator and project legs
- transfer and return
- model/thinking redials
- page rescue and hangup
- leg teardown and recreation
- stale-session rejection

Pi may request a transfer or return through a tool signal. It does not mutate
the route directly. A wedged or confused agent must not be able to strand the
caller.

### 2. Pi owns agent reasoning, not the call

`apps/backend/src/pi_client.rs` owns the operator's process/RPC transport, and
`apps/backend/src/project_session.rs` the service's side of a project session
over the host link. The agent (the operator's Pi process, or a project's
prime-agent session) owns prompts, model responses, tool calls, and project
work. It does not own:

- which leg is active
- the project registry
- the host link
- browser delivery
- call rescue
- final routing decisions

A future model-text-to-TTS stream belongs at the Pi event boundary, not as a
special case hidden in browser code or PBX mutation.

### 3. The application files coordinate application behavior

The application boundary for HTTP, WebSocket, turn dispatch, audio delivery,
generation checks, and worker coordination is a set of files in
`apps/backend/src/`, one concern each: `api.rs` (the router), `app_state.rs`,
`browser.rs`, `page_controls.rs`, `module_calls.rs`, `caller_input.rs`,
`turns.rs`, `host_turns.rs`, `speech.rs`, `floor_hooks.rs`, and
`leg_announcer.rs`. They may
coordinate these concerns, but they must not become the owner of
provider-specific speech protocols or Pi routing policy.

Important application behavior must remain visible through named operations,
events, or state transitions. Do not hide a route change, persistence action,
or cancellation side effect inside an unrelated helper.

Host-reported project turns are admitted through the coordinator
(`handle_project_turn` in `host_turns.rs`). A
`turn_start` with `cause: autonomous` opens a server-owned operation with the
host's `turn_id`; caller prompts wait behind it. It closes on that turn's
`turn_end`, or when the session closes (`session_closed`, which a lost host
link also sends): a closed session never ends its run, and the operation
would hold every later caller prompt. A caller prompt's operation
closes when the host reports its bound turn settled (`turn_end` with that
`turn_id`), even if the prompt has not returned yet, so a run the host starts
right behind it gets an operation of its own. Module calls (`module_calls.rs`) must carry the
same authority, and a stale or authority-less self-wake call is refused rather
than attached to whichever caller operation won the race. An old host may omit
these additive fields for ordinary caller turns, but its self-wake effects
and written autonomous output fail closed. Written autonomous replies from
new hosts use the existing `Reply` event and do not enter the speech worker.

`HostTurn::of` reads each report once, and the application answers it:

| Report | The application |
|---|---|
| a start whose token is not the leg on the line's | ignores it |
| `turn_start`, `input` | binds its turn id to the caller's operation |
| `turn_start`, `autonomous`, with a turn id | opens an operation for the run if the leg is free, and holds the run (its session instance and operation) until its end; one is held at a time |
| `turn_start`, `autonomous` or `unknown` without a turn id, `unknown` with one, or any other cause | admits nothing |
| `turn_end`, `input`, with a turn id | closes the open operation bound to that id (`settle_turn`) |
| the end of a self-woken run (any other cause) | only for the held run (same session instance and turn id): closes its operation, traces its end, and writes its text, if any, to the transcript |

The table test `a_host_reported_turn_moves_by_its_table`
(`apps/backend/tests/test_host_turns.rs`) holds every phase of the line against
every report.

### 4. Audio is an adapter boundary

`apps/backend/src/audio.rs` owns speech transport and worker mechanics:

- `SttAdapter` for complete-clip compatibility
- `SttStreamAdapter` for long-lived streaming STT
- `TtsTransport` for provider transport
- `Speaker` for speech request policy and limits
- worker framing, deadlines, output bounds, and process cleanup

Audio adapters may report partial, final, failed, or cancelled results. They do
not decide which project receives a transcript or whether a caller is
transferred. That remains application/PBX policy.

Replacing ElevenLabs with a local model should replace a transport adapter and
configuration, not the browser protocol, turn epochs, or PBX lifecycle.

### 5. The browser owns presentation and capture

`apps/frontend/src/runtime/` owns the call:

- microphone permission and capture
- wake/VAD state (reusing `hands_free.ts`, the local wake detector, and the
  Silero speech endpointer)
- WebSocket framing from the browser side
- audio playback and MSE fallback

The React app around it (`apps/frontend/src/integration/runtime.tsx`,
`src/controller/`, `src/components/`) owns:

- display and diagram rendering
- status and route presentation

The browser does not own:

- project authority
- route truth
- session identity
- generation validity
- transcript persistence

The server is authoritative. Browser state is a projection that may be
reconnected, discarded, or replayed.

### 6. Protocols are contracts, not implementation details

The browser/server WebSocket protocol is the contract between
`apps/frontend/src/protocol.ts` and the service. Each message the service
sends the browser is a variant of `ServerMessage`, defined once in
`apps/backend/src/protocol.rs` and once in `protocol.ts`, and the service
builds every one through it. Both definitions are held to the same examples,
`apps/frontend/tests/fixtures/server-messages.json`: each example must
serialize to itself in Rust and decode to itself in the browser, and a type
with no example fails on both sides. The browser admits a text frame only as
one of those messages and drops anything else.

The commands the browser sends go the other way the same way. Each is a
variant of `ClientMessage` in `protocol.rs`, built by one builder in
`protocol.ts`, and `handle_text_frame` reads every text frame as one and
matches on it. Both are held to
`apps/frontend/tests/fixtures/client-messages.json`: each example must be
exactly what its builder sends (in the browser) and read back to itself (in
Rust), and a command with no example fails. The Rust round trip is what
catches a renamed or wrong-kind field, in every command. The browser check
catches a rename only in a field a builder maps by name, and checks no
kinds; the `screen_state` builder passes the report through, so that command
is held to `ScreenStateReport` by type instead. The service reads a
command's fields leniently, as it always has: a field missing or of the
wrong kind is absent, and the handler decides what absent means; so the
fixture, not the reader, is what catches a field one side renamed. A frame
that is not JSON, not an object, or of no known type is answered with an
`error` and the socket stays open.

Changes to message types, framing, MIME rules, sequence numbers, generations,
or environment variables are public contract changes. A new or changed
message, in either direction, changes both definitions and its fixture
together.

Every protocol addition must define:

- owner and direction
- framing and size limits
- ordering and replay behavior
- cancellation behavior
- stale-generation behavior
- fallback for an older peer
- focused protocol tests

### 7. Generations and epochs own freshness

A generation or connection epoch is not decoration. It prevents work accepted
before a rescue, redial, transfer, reconnect, or newer turn from changing the
current call.

Every asynchronous path that can publish, persist, speak, steer, route, or
queue work must check the current generation at the boundary where the side
effect occurs. Cancellation must release resources and wake waiting callers;
merely ignoring a late result is not sufficient.

### 8. Signals are separate from actions

Agent tools emit signals through the established session contract. The
operator's Pi extension registers `route` (and the utility's
`second_opinion`, `rewrite` and `dispatch_parts`), read from its RPC events;
a project agent's `switchboard` skill module sends `speak`,
`request_to_speak`, `display` and `view` as module calls over the host link.
A tool only signals; the service decides what action those signals cause.

This separation keeps tools small, makes failures recoverable, and prevents an
agent from acquiring hidden authority over the switchboard.

### 9. One implementation per lifecycle

A fallback is an adapter or an explicit refusal, never a second copy of the
lifecycle kept for "when the real one is absent". pbx.rs once carried a full
transfer-time setup path for a switchboard without prewarm. Production always
had prewarm, nothing ran that path on purpose, and two holes led back into it
anyway: an extension prewarm could not stage was uploaded live, and a redial
that could not reach prewarm opened its own connection to the host. A second
implementation is untested in the configuration that matters and silently
reachable in the one that does not.

A flag, a nullable slot, a timer or a token added to a lifecycle owner, or a
third copy of its end, means the lifecycle has stopped being one state type
with one writer: extract the machine first, in its own PR (`AGENTS.md`,
"Working here"; the "one writer per machine" and "no new lifecycle flags"
checks in `scripts/check_hygiene.mjs`).

The same holds across a contract. The complete-clip `SWITCHBOARD_STT_COMMAND`
contract and the optional long-lived `SWITCHBOARD_STT_STREAM_COMMAND` are two
explicit transports behind one adapter, with a stated fallback between them.
Both sides of an environment contract change together: application here,
deployment in homelab.

### 10. Deployment stays outside this repository

Homelab owns:

- systemd and runtime installation on damocles
- the host tokens (`SWITCHBOARD_HOST_TOKENS_FILE`)
- project registry
- persona and operator prompt
- secrets
- `SWITCHBOARD_*` environment files

This repository owns application behavior, extension and skill source, and
the host-agent installer, which is run from the pinned commit. A deployment
change requires a separate homelab change (e.g. pinning binary release tags/checksums).
Never place secrets or deployment workarounds here to make a local feature appear complete.

### 11. Prewarm owns launch setup

`apps/backend/src/prewarm.rs` does all of the setup a project leg needs, as
each host links: the model catalog per host (the host agent's `list_models`)
and each project's prepare command (`run_prepare`). Nothing is copied to a
host; the host-agent installer ships the skill module.

- **No resident project session at startup.** Project sessions start on
  transfer.
- **Launch plans, not setup.** A transfer or redial asks prewarm for a
  `LaunchPlan` (prepare report, catalog, host) and starts the session from it.
  Nothing else reaches the host at transfer time: no prepare, no model
  listing.
- **Refusal, not fallback.** A project with no host, or a host that is not
  connected, is a refused transfer or redial, and a live leg keeps running.
- **Settled once.** Prepare results (success, nonzero, or timeout) are
  timestamped reports that are launchable and never retried; only a prepare a
  lost link cut off runs again on the next link.

### 12. Model fallback is model policy

Prewarm reports a catalog that could not be listed as unavailable, with its
reason; it does not decide what that admits. `ModelCatalog::resolve` in
`models.rs` does: a provider-qualified spec passes through when discovery is
unavailable, and also passes through when its provider is listed but its model
id is not. The daemon remains authoritative for that model id. A bare name is
still resolved against the catalog, and an unknown provider is refused.

## Ports and adapters

### Inbound adapters

- browser WebSocket audio/control frames
- browser HTTP controls: connect, hangup, thinking, and model
- host-link frames: command replies, session events and snapshots, and module
  calls (speak, display, view, request_to_speak)
- Pi RPC events and tool signals from the operator
- process/stdin/stdout lifecycle events
- startup configuration and environment values

### Application ports

These are the seams the core behavior should depend on:

- leg/route operations in the PBX and coordinator
- Pi session/process operations
- complete and streaming STT operations
- collecting and streaming TTS operations
- ordered browser delivery
- transcript/history persistence
- project/model registry lookup

The current Rust code uses concrete structs in some of these seams. When a new
feature needs substitution or isolation, introduce the smallest port that
removes the real coupling; do not create interfaces for ceremony.

### Outbound adapters

- `PiSession` (the operator) and `ProjectSession` (a project session over the
  host link)
- `SttAdapter` and `SttStreamAdapter`
- `TtsTransport` and ElevenLabs HTTP streaming
- WebSocket delivery and browser binary/text frames
- history and registry storage
- homelab-provided environment contracts

## Package responsibilities

| Area | Owns | Must not own |
|---|---|---|
| `apps/backend/src/main.rs` | composition root; `Config`, the only reader of the environment | turn policy |
| `api.rs` | the primary router, `/healthz`, the debug listener's router, and the origin check both listeners apply | anything a handler does |
| `app_state.rs` | `AppState`/`AppInner` and their construction (the callbacks installed into the PBX and coordinator), the workers, shutdown, the event fan-out, the operation registry, the resident-agent projection | provider wire formats, PBX policy |
| `browser.rs` | the `/ws` connection and its size bound: registration, snapshot, the frame multiplexer, which screen reports count, frame writes | what a command does once parsed, the screen report's shape (`display.rs`) |
| `page_controls.rs` | `/status`, `/connect`, `/thinking`, `/model`, `/hangup`, the rescue each control starts with, and the control's one flow from admission to settle (`PageControl`) | leg lifecycle (the PBX's), redial decisions (`RedialPlanner`'s) |
| `module_calls.rs` | the `/host` upgrade and a project session's `speak`, `request_to_speak`, `display`, `view`, with the one admission every acting call passes | the host link itself (`hosts.rs`), the display projection, who is waiting to speak (`floor.rs`'s) |
| `caller_input.rs` | clips, streamed clips, typed turns, transcription, and each clip's verdict, up to a logged transcript | routing that transcript |
| `turns.rs` | routing a transcript through Jev without the PBX lock, the turn worker and a caller turn's one end (`TurnRun`) | speech synthesis, PBX policy, host-reported turns (`host_turns.rs`'s) |
| `host_turns.rs` | host-reported turns: each report read once (`HostTurn`) and answered through the coordinator, and the one self-woken run admitted as an operation (`HostTurns`, its `SelfWokenRun` written only by `hold_self_woken` and `release_self_woken`) | a session's turn (`session_turn.rs`'s), caller turn dispatch |
| `speech.rs` | the one ordered speech worker, its continuity, audio slots, and reply voice; each request's one completion (`PendingSpeech::complete`, one `SpeechOutcome` per request; `docs/concurrency-and-test-hazards.md`, "How a speech request ends") | the TTS provider's wire format, the audio queue itself, floor policy |
| `leg_announcer.rs` | announcing a new leg to the browser, once per leg: the speech reset, the `epoch`, the held-scene replay | which leg is current (the coordinator's), the stage's reset (`DisplayGateState::begin_leg`) |
| `floor.rs` | the background request queue and who is waiting (reported through its `Waiting` hook), the front request's phases (`FrontPhase`, written only by `step`): Jev good-moment holds, stateless rewrites, the release and its retry | lifecycle membership, the agent projection itself, route authority, TTS provider wire format |
| `floor_hooks.rs` | the application side of `floor.rs`'s hooks: whether the page is connected, whether a request is still live (`still_live`, the one check), the Jev good-moment gate, the utility rewrite under its timeout, the release through the speech worker, and mirroring who is waiting into the agent projection (`waiting_hook`) | the floor's queue, order and phases (`floor.rs`'s), the speech worker (`speech.rs`'s) |
| `lifecycle.rs` | the coordinator: the call line's one writer (`CallLifecycle::step`) and its lock, the candidate notices, the status projection; call identity, the current route and the leg on it, candidate legs, operations, the status | async work or I/O, the phases and their transitions (`call_line.rs`'s) |
| `call_line.rs` | the call line (`Line`, its phase data and its one transition function, `Line::next`; see "Call line"): pure, it reads the line and returns the next one | the lock, writing the line, sending notices, async work or I/O |
| `pbx.rs` | the `Switchboard`: its state, construction, callbacks, shared session guard and shutdown; the call types the other files share (`OPERATOR`, `TransferContext`, `AgentStateNotice`) | host setup, browser rendering, TTS encoding, a copy of the route |
| `decisions.rs` | what a Jev decision does with a caller's line: continue, go to a project, split, take over, stop on confirmation, the utility's second opinion, the operator fallback; the routing trace | Jev's classification (`router.rs`), a second commit path |
| `leg_transitions.rs` | transfer, background promotion, takeover, return, hangup and stop; the one bring-up owner (`Startup`: `commit` and `abandon`) | which leg is on the line (the coordinator's), redial decisions |
| `redial.rs` | model and thinking changes: `RedialPlanner`'s decision without the PBX lock, and `Switchboard::redial` | a second commit path |
| `residents.rs` | background residents: `BackgroundRegistry`, shelving, split-part starts, detached prompts, eviction on host loss | which leg is on the line, promotion (`leg_transitions.rs`) |
| `operator.rs` | the operator's Pi process and the routing utility process: how each is launched, their slot (`LocalProcess`: one `ensure`, one `close`), the shared `RoutingUtility` the floor reaches without the PBX lock, recovery, utility requests, floor rewrites | routing policy, the process's own phase (`pi_client.rs`'s) |
| `routing_view.rs` | `RoutingView`, what routing reads without the PBX lock, and the desk-session listing | any change to the call |
| `prompts.rs` | the call's prompt text: the voice block, the voice brief, the foreground and background notices, the utility's rules, the intro prompt | when or to whom a prompt is sent |
| `reply.rs` | `Reply` and the switchboard's reply and failure builders | routing or lifecycle policy |
| `hosts.rs` | the host link: admission by token, heartbeats, commands and replies, session subscriptions (a `Subscription` ends its own delivery when dropped), module calls | routing decisions, leg lifecycle |
| `prewarm.rs` | per-host setup and launch plans: catalogs, prepare | routing decisions, model policy |
| `pi_client.rs` | the operator's and the utility's Pi process/RPC transport and its phase (`ProcessState`: idle, sending, prompting, abandoned, closed; moved only by `PiSession::transition` through the `step` table, with the release on entry to closed), process-tree cleanup, `LegSession` (the leg on the line, operator or project, as the controls see it) | project sessions, route authority or deployment registry |
| `project_session.rs` | a project session over the host link: its commands, the caller turn it collects, the frame pump and what each turn step leaves to do (reports, admission, frames to the prompt), module-call answers, and its end of life (`Lifecycle`, written only by `ProjectInner::end`; `docs/host-link.md`, "A project session's end"): its release on the host and the subscription to its frames | the host link itself (`hosts.rs`), which leg is on the line, route authority |
| `session_turn.rs` | a project session's turn (`TurnState`: idle, caller, self-woken, caller and self-woken, caller settled, and a refused self-woken start; written only by `TurnState::step`, which is pure and returns its effects; `docs/host-link.md`, "A project session's turn") | the host link, the session's end of life, admission policy (the application answers it) |
| `audio.rs` | STT/TTS transports, workers, bounds, deadlines | project selection or persistence policy |
| `display.rs` | the stage projection (`DisplayProjection`); the display gate (`DisplayGateState`: the stage of the leg on the line, the page's `ScreenReport` and its confirmations, whose methods are their only writers); the display-precedence rule for `view` and the snapshot | generation checks, HTTP/WebSocket handling |
| `delivery.rs` | the event envelope, per-connection framing (`DeliveryState`), and the ordered audio queue | route authority, generation checks |
| `models.rs` | catalog parsing and spoken model/thinking resolution | where catalogs come from |
| `registry.rs` | the project registry and spoken-name resolution | agent reasoning |
| `history.rs` | transcript storage shape | deciding when a turn routes |
| `visual_protocol.rs` | display action validation and normalization | layout |
| `protocol.rs` | the shape of every message sent to the browser (`ServerMessage`) and every command it sends (`ClientMessage`) | when or to whom a message is sent; what a command does |
| `debug.rs` | bounded, in-memory observation: the event and log rings, the debug schema (`DebugEvent`), record scrubbing and clipping, and the debug listener's router and WebSocket framing | call control, routing or lifecycle decisions, awaiting on clients or doing I/O while publishing, disk history |
| `apps/frontend/` | capture, protocol client, playback, UI | server authority or durable state |
| `apps/host-agent/src/sessions.ts` | the sessions a host agent tracks on its daemon: provenance and the state file, each session's call, and its turn (`Tracked.turn`, written only by `#turnStep`; `docs/host-link.md`, "Session events") | the host link (`link.ts`), running prepare commands |
| `apps/host-agent/src/daemon_keeper.ts` | the daemon connection and the resync after it: one phase (`disconnected`, `resyncing`, `retrying` the sessions that would not attach, `attached`), written only by `#step` (`docs/host-link.md`, "Snapshots") | what a session reattach does (`sessions.ts`), starting a daemon |
| `apps/host-agent/src/prepare.ts` | `run_prepare`: the bounded `sh -c` runner and the join of a run already going in the same folder (`Prepares`) | sessions, the host link |
| `extensions/` | the operator's Pi-side tool signal | direct route mutation |
| homelab | deployment and secrets | application implementation |

## Call line

The coordinator holds the call as one value, `Line` in `call_line.rs`.
Each phase carries what exists only in it, so a candidate, the leg a
startup would restore, or a turn cannot outlive its phase. `Line::next`
is the one transition function: a match of phase by event that returns
the next line and the candidate notice the move owes the browser, and
changes nothing when it refuses. `CallLifecycle::step` (`lifecycle.rs`)
is the one writer of the line, and `Coordinator::step_locked` sends the
notice, refreshes the status projection and wakes waiting turns for every
transition, under the state lock. Each public transition (`begin_prompt`,
`begin_candidate`, `adopt_candidate`, `begin_rescue`, ...) is one event
through them.

| phase | carries | entered by | left by |
|---|---|---|---|
| `Open` | the leg on the line; the turn running on it, if any | the call starts here; `settle`, `finish_intro`, a rollback, `return_to_operator` from `Quiescing` | `begin_candidate`, a rescue, `begin_shutdown` |
| `Starting` | the leg, which still answers; the staged candidate, private until adopted; the leg's turn (a transfer runs inside the caller's) | `begin_candidate` | `adopt_candidate`; a rollback (to `Open`, the turn kept); a rescue or shutdown, which abandon the candidate and retire its generation |
| `Adopted` | the adopted leg and its intro (or later) turn; the leg it `replaced` | `adopt_candidate` | `finish_intro` (to `Open`); a rollback (`replaced` comes back); a rescue; a shutdown; another `begin_candidate` |
| `Quiescing` | the leg under the rescue's new identity; no turn | a rescue | a settle naming that rescue's generation (`settle`, `settle_at`), `return_to_operator`, `begin_candidate`, a shutdown |
| `Shutdown` | the leg; no turn, no startup | `begin_shutdown` | nothing |

Entering `Starting` announces the candidate (`candidate`); leaving it
announces how it ended (`candidate_cleared` with `adopted`,
`rolled_back` or `rescued`; a shutdown ends it as a rescue does), and a
rollback of an adopted leg announces `rolled_back` again.
`the_call_line_phase_by_event` in `apps/backend/tests/test_lifecycle.rs`
pins every phase against every event. A new way to move the call is an
`Event` and its arms in `Line::next`, never a field beside the line.

### A leg's bring-up

A transfer, a background promotion, a takeover and a redial bring a
project leg up through the call line, never beside it. Each is a fixed
sequence with failure exits, not a machine: one `Startup` value
(`leg_transitions.rs`) owns it from the candidate it stages until it
commits or abandons, and the call line is what it commits or rolls back.

| step | what the `Startup` holds | on failure |
|---|---|---|
| `Switchboard::begin_startup` | the staged candidate's identity, the project, the change (`LegChange`: a new agent or a redial) | refused before anything is staged: the caller answers |
| `attach` | the session, now named on the active-session guard | `abandon` (nothing attached: the rollback alone) |
| the first turn (a redial has none) | the same | `abandon` |
| `commit` | consumed: the leg is the PBX's agent and the guard's, and the identity it is on the line under is returned | a failed adoption abandons |

`abandon` is the one failure exit, in one order: the attached session is
ended, a new agent is published `finished`, and, under the guard's lock,
the call line rolls back to the leg before it and the guard names that
leg again. A redial's failure then drops the leg
(`drop_agent`). A `Startup` dropped without either (its future aborted, a
panic) rolls its candidate back in `Drop`; the guard and the session are
left to the rescue that aborted it. A rollback names the generation its
startup staged at (`rollback_startup`), so one whose startup has already
ended (committed, rescued, rolled back) does nothing.
`every_bring_up_exit_leaves_the_line_as_the_table_says` in
`apps/backend/tests/test_leg_transitions.rs` pins every bring-up at every
exit. A new way to bring a leg up holds a `Startup`; a new failure exit
calls `abandon`.

### The session guard

The active-session guard (`Switchboard::active_session`, shared with the
application as `AppInner::active_session`) names the session steering and
a page rescue act on. It is derived state, not a machine:
`Switchboard::name_leg_on_line` (`pbx.rs`) is its one writer, and it takes
no session to name. It names, in order:

| case | the guard names |
|---|---|
| a bring-up has attached its session (`Startup::attach`) | that session, over whatever is on the line |
| a project is on the line | the PBX's agent, if it is that project's session (`agent_on_the_line`) and alive |
| the operator is on the line | the operator's process, if it is alive |
| otherwise, or the session has ended | nothing |

Each change to the legs calls it after it changes `agent`, `operator` or
the route: `Startup::attach`, `commit` and `abandon`, `drop_agent`,
`force_hangup`, the operator's start and recovery (`operator.rs`), and
`shutdown`. A change that also moves the call line (`abandon`'s rollback,
`drop_agent`'s return to the operator) moves it inside the writer, under
the guard's lock, so a rescue finds the guard and the line agreeing. The
operator answering while a project is on the line leaves the guard on the
project, because the derivation reads the route, not the caller. A
rescue's `take` (`page_controls.rs`) is the one other change: it empties
the guard and ends the session, and since an ended session is never named,
no later change hands it back. `every_change_to_the_legs_leaves_the_guard_as_the_table_says`
in `apps/backend/tests/test_pbx.rs` pins six call states against eight
changes to the legs.

### A page control

`/connect`, `/model`, `/thinking` and `/hangup` take one flow
(`page_controls.rs`). It is a fixed sequence with failure exits, not a
machine: each step consumes the control and returns the next, and the
coordinator's rescue token (`lifecycle::Rescued`) is the only generation a
step after the rescue gets, so none can read the current one again
(#263, #369).

| step | holds | on failure |
|---|---|---|
| `PageControl::admit` | `Admitted`: the generation the page held, which is the call's | 400 with none, 409 for one the call has left: "refused" (a picker), "ignored" (a hangup) |
| `Admitted::decide` (a redial only) | the decision, registered at the admitted generation; running work is left alone | as `run`, at the admitted generation; an answer that needs no redial (a refusal, a setting on the operator) is delivered there and nothing is rescued |
| `Admitted::rescue` (`begin_rescue_at`), `rescue_for` (`begin_rescue_of`, a redial) | `Rescued`: the token, after the leg's work is released | nothing rescued: 409 ("cancelled", "ignored", "superseded") |
| `Rescued::run` (the dial, the redial) | the operation, registered at the token's generation | 409 "cancelled" if a newer rescue retired it (that one settles); 500 and a settle if it failed |
| `Rescued::lock_pbx` (the hangup) | the PBX, checked under its lock against the token | 409 "superseded": a newer control owns the call |
| `deliver` | the reply, delivered at its generation; the delivery settles | 409 "superseded" |
| `Rescued::settle` | consumes the token: ends the quiet only while the call is at its generation | none: a newer rescue's quiet is that rescue's to end |

`every_page_control_exit_leaves_the_line_as_the_table_says` in
`apps/backend/tests/test_page_controls.rs` drives each control through
each exit and pins the answer and the line it leaves. A new control is a
handler that composes these steps; a new exit is a row there.

### The operator and the routing utility

The operator and the routing utility are local pi processes, each held in
a `LocalProcess` slot (`operator.rs`). A slot is empty, or holds a process
that is live or has died. Nothing reports a death: the slot finds it when
the process is next needed. `LocalProcess::ensure` is the one place a
process is started and a dead one closed and replaced, and
`LocalProcess::close` is the one end. A restart has no backoff: a binary
that keeps crashing fails one prompt at a time.

| slot | ensure | ensure, the start fails | close |
|---|---|---|---|
| empty | starts one | stays empty, the error returns | nothing |
| live | keeps it | keeps it (no start is tried) | closes it, empty |
| dead | closes it, starts one | closes it, empty, the error returns | closes it, empty |

`a_local_process_slot_starts_keeps_restarts_and_closes_by_its_phase` in
`apps/backend/tests/test_operator.rs` pins this table for both slots.

The operator's slot is `Switchboard::operator`, under the PBX lock. A
started operator renames the session guard; `recover_operator`,
`force_hangup` and `shutdown` close it. The utility's slot is inside
`RoutingUtility`, behind a lock of its own. The switchboard keeps one
clone for second opinions and split dispatch, and `AppInner` keeps one
for the floor's rewrite (`floor_hooks.rs`), so a foreground turn that
holds the PBX lock for its whole prompt does not hold a background update
past its rewrite (#386). The utility's lock covers finding or starting
the process only; a prompt runs on the session it hands out. The
process's own phase (idle, prompting, abandoned, closed) is
`pi_client.rs`'s `ProcessState`; the slot reads it only through
`alive()`.

## Turn lifecycle

A normal voice turn should remain traceable as:

```text
capture
  -> WebSocket admission
  -> STT adapter / streaming worker
  -> final transcript claim
  -> current-generation turn dispatch
  -> Pi session and tool loop
  -> speak/display signal (or a written reply with no audio)
  -> reply/History voiced metadata for the live conversation surface
  -> TTS transport
  -> ordered audio events
  -> browser playback
```

Each caller turn has one owner from the queue to its end, in `turns.rs`.
A transcript from any source (a clip, a streamed clip, a typed turn) reaches
routing through `route_final_transcript` (`caller_input.rs`). From then on:

| phase | owner | how it ends |
|---|---|---|
| routing | `dispatch_routed_transcript` | steered into the running turn, queued, or refused as stale |
| queued | the turn worker (`process_turns`), counted in `TurnState` | refused as stale |
| awaiting admission | `admit_turn`, behind any running operation | admitted with an operation, or refused as stale |
| admitted to settled | `TurnRun`: the operation, the leg, the speech group; `TurnRun::drive` registers and awaits the task | `TurnRun::finish` with one `TurnOutcome`: `NotRegistered`, `Cancelled`, `Failed` or `Replied` |

Every stale exit, in any phase before the turn's task runs, goes through
`refuse_stale`: the routing trace ends as `dropped_stale` and the page gets
an ID-bearing `stale_epoch`. `TurnRun::finish` is the only end of an
admitted turn. It releases the operation (`drive` has already taken the
task out of the registry), traces the end, reports the outcome (a reply is
delivered only while its generation is current), and only then drops the
speech group and frees the worker. A new
way for a turn to end is a `TurnOutcome` variant, not another end path.

A streaming worker's partial results are logged and go no further: they are
not shown, persisted, routed, steered, or spoken. The page has no place for a
caller line that is still being recognized, so the service does not send
them. A final result may be claimed only once. A failed or abandoned
stream must either complete through the complete-clip contract or report a bounded,
visible failure; it must not silently create a duplicate turn.

## Background updates: the floor

A background agent's `request_to_speak` waits on the floor (`floor.rs`)
until the caller can hear it. The floor is the one owner of who is waiting:
it marks an agent waiting when it queues the agent's request, and ends the
mark when the agent's last request on the floor is spoken. It reports both
through its `Waiting` hook, under its lock, and `floor_hooks::waiting_hook`
mirrors them into the agent projection the page and Jev read. The PBX's
state notices are the projection's other writer: any notice but `idle`
replaces an agent's waiting mark.

The queue holds the front request and, behind it, at most one waiting
request per agent; a newer one replaces the agent's waiting one. One worker
takes the front request through its phases (`FrontPhase`). `step` is the
only writer of the phase; `Floor::act` does what the phase asks for and
reports it as an event; every read of the floor and every release listens
for floor events first (`Floor::listen`), so none is lost between a read and
a wait.

| phase | what the worker does | next |
|---|---|---|
| reading | reads the page and the caller's last words | awaiting the page, awaiting quiet (held), gating (not held), rewriting (held, quiet) |
| awaiting the page | waits for a floor event | reading |
| awaiting quiet | waits for the threshold after the hold and after the caller's last words, or a floor event | reading |
| gating | asks Jev for a good moment | rewriting (yes); reading, held from now (no, or failed) |
| rewriting | checks the agent is live, asks the utility for words (the agent's own on failure), checks again | releasing; left, agent gone |
| releasing | speaks the words through the speech worker | left, played; left, agent gone; retrying (no audio, page there); reading (no page) |
| retrying the release | waits `RETRY_AFTER`, or a floor event | releasing the same words; reading |

A held request (Jev said no, or failed) is never gated again; it is spoken
at the next quiet moment, and its trace says `quiet_after_hold`. Leaving the
floor is one teardown, whichever phase the request left from: the
`floor_released` trace, its place in the queue, and, when it was spoken and
was its agent's last, the agent's waiting mark.

## Streaming rules

Streaming reduces waiting; it does not remove lifecycle boundaries.

- bound queues by bytes as well as item count
- never block cancellation behind a full audio/STT queue
- preserve chunk identity and ordering
- stop producers when their generation is stale
- make provider EOF, deadline, and write failures visible
- retain only bounded replay data for browser fallback
- keep final persistence and routing on the completed/final path
- test disconnect, reconnect, cancellation, worker death, and playback failure

When streaming model text into TTS, use a phrase/sentence boundary or an
explicit provider text-input stream. Do not send incomplete tool-call JSON or
speak every token independently.

## Observability and failure ownership

Every important boundary should have a useful trace or event:

- connection/epoch and generation
- capture and first audio chunk
- STT partial/final and final claim
- route and leg transition
- Pi process start/stop and tool signal
- TTS request, provider first byte, and audio completion
- cancellation, rescue, timeout, and fallback

In the journal, a line names the browser connection, request, or turn it
belongs to through a span (`ws`, `http`, `module_call`, `turn`, `stt`); `README.md` lists
them under "Operating it".

Failure ownership should be obvious:

- browser capture failure: browser reports it and releases the mic
- STT worker failure: audio adapter reports it; application decides fallback
- Pi or host-link failure: PBX returns the caller to the operator
- TTS failure: application reports it; the written reply remains in the transcript
- stale result: generation gate discards it without side effects. Speech a
  rescue cancels or supersedes is one: its requester learns it was not
  spoken, and the page shows no error for it
- deployment mismatch: configuration/health surface names the missing contract

## Architectural test

Before adding a feature, answer these questions:

1. Which component owns this behavior?
2. Is the lifecycle or phase visible?
3. Is the provider behind an adapter where substitution is real?
4. Does the browser remain a projection rather than an authority?
5. Are generations, cancellation, reconnects, and fallback defined?
6. Does the environment contract have a homelab counterpart?
7. Can a focused test prove the boundary without network, hardware, or model downloads?
8. Will debugging the feature later be easier or harder?

If the answer is unclear, stop and make the ownership explicit before adding
another callback or flag.

## Known non-purity

Switchboard is not currently a perfect hexagonal implementation:

- `Switchboard::handle` (`decisions.rs`) is a test-only way onto the line
  without a routing decision: the words go to whichever leg holds the route.
  Production always arrives through `handle_decision` with Jev's verdict.
- The display precedence rule is implemented twice, in `DisplayProjection`
  (`display.rs`, for `view` and the snapshot) and in the browser's
  `sceneModel.ts`, on purpose: the server answers `view` without asking the
  browser, and the browser renders without a round trip. This is now a
  checked duplication rather than an unchecked one: both are held to
  `apps/frontend/tests/fixtures/display-precedence.json`, read by a Rust test
  in `display.rs`'s tests and a vitest test, so the two rules cannot drift
  apart unnoticed.
- `apps/frontend/src/runtime/callRuntime.ts` still coordinates several
  concerns (socket lifecycle, outbox, line requests); the recorder, playback
  and hands-free are separate modules, the rest is one class. Hands-free's
  whole lifecycle, its first load and follow-up lease included, is the
  controller's: the runtime only tells it what happened
  (`docs/hands-free.md`).
- browser event variants and Rust delivery events are intentionally coupled at
  the wire boundary.
- `Speaker` still contains ElevenLabs-specific request policy.
- `PiSession::collect` still represents a settlement boundary, so model-text to
  TTS streaming requires a deliberate Pi event-stream extension.

These are known tradeoffs, not invitations to create abstractions everywhere.
Extract a new port when a feature needs substitution, concurrency isolation, or
a test seam. Otherwise prefer the existing owner and the smallest change.
