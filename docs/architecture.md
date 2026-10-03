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
  WebSocket and HTTP adapters
          |
          v
  api.rs: application coordination
          |
          +--> lifecycle.rs: the coordinator -- call identity, the current
          |       route and leg, phases, freshness, the status
          |
          +--> pbx.rs: leg lifecycle and what is behind each leg
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

`apps/backend/src/pbx.rs` and the coordinator (`lifecycle.rs`) own the call.
The coordinator owns which leg is on the line (route, project, model, session,
thinking, catalog) and builds the status from it alone; the PBX owns the
processes and changes the leg only through the coordinator's named transitions
(`begin_candidate`, `adopt_candidate`, `rollback_startup`,
`return_to_operator`). Every transition that brings a project leg up (a
transfer, a background promotion, a takeover, a redial) commits it through
`Switchboard::commit_leg`, so each takes the same steps in the same order. A
rescue ends in `settle`, which every page control and
delivered turn passes through. A model or thinking redial is decided before
anything is torn down: `RedialPlanner` (`pbx.rs`) makes every refusal from the
coordinator's leg and prewarm's launch plan, without the PBX lock, so a refused
page swap never rescues the live leg; `Switchboard::redial` runs a plan only
while the leg it was made for is still on the line. Between them they own:

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

`apps/backend/src/pi_client.rs` owns the operator's process/RPC transport and
the service's side of a project session over the host link. The agent (the
operator's Pi process, or a project's prime-agent session) owns prompts, model
responses, tool calls, and project work. It does not own:

- which leg is active
- the project registry
- the host link
- browser delivery
- call rescue
- final routing decisions

A future model-text-to-TTS stream belongs at the Pi event boundary, not as a
special case hidden in browser code or PBX mutation.

### 3. `api.rs` coordinates application behavior

`apps/backend/src/api.rs` is the application boundary for HTTP, WebSocket, turn dispatch,
audio delivery, generation checks, and worker coordination. It may coordinate
these concerns, but it must not become the owner of provider-specific speech
protocols or Pi routing policy.

Important application behavior must remain visible through named operations,
events, or state transitions. Do not hide a route change, persistence action,
or cancellation side effect inside an unrelated helper.

Host-reported project turns are admitted here through the coordinator. A
`turn_start` with `cause: autonomous` opens a server-owned operation with the
host's `turn_id`; caller prompts wait behind it. A caller prompt's operation
closes when the host reports its bound turn settled (`turn_end` with that
`turn_id`), even if the prompt has not returned yet, so a run the host starts
right behind it gets an operation of its own. Module calls must carry the
same authority, and a stale or authority-less self-wake call is refused rather
than attached to whichever caller operation won the race. An old host may omit
these additive fields for ordinary caller turns, but its self-wake effects
and written autonomous output fail closed. Written autonomous replies from
new hosts use the existing `Reply` event and do not enter the speech worker.

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
- wake/VAD state (reusing `hands_free.ts` and the local wake detector)
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
`apps/backend/src/protocol.rs` and once in `protocol.ts`, and `api.rs` builds
every one through it. Both definitions are held to the same examples,
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

Agent tools such as `transfer_to_project`, `return_to_operator`, `speak`, and
`display` (the operator's Pi extension, and a project agent's `switchboard`
skill module) emit signals through the established session contract: the
operator's RPC events, or module calls over the host link.
The service decides what action those signals cause.

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
| `api.rs` | HTTP/WebSocket coordination, turn dispatch, workers, generation checks | provider wire formats, PBX policy, the display projection, the audio queue |
| `floor.rs` | ordered background request queue, Jev good-moment holds, stateless rewrites, announce-first release | lifecycle membership, agent-state projection, route authority, TTS provider wire format |
| `lifecycle.rs` | call identity, the current route and the leg on it, phases, candidate legs, operations, the status | async work or I/O |
| `pbx.rs` | leg lifecycle: transfer, takeover, return, rescue, redial and its decision; the operator process and project sessions | host setup, browser rendering, TTS encoding, a copy of the route |
| `hosts.rs` | the host link: admission by token, heartbeats, commands and replies, session subscriptions, module calls | routing decisions, leg lifecycle |
| `prewarm.rs` | per-host setup and launch plans: catalogs, prepare | routing decisions, model policy |
| `pi_client.rs` | the operator's Pi process/RPC transport, project sessions over the host link, process-tree cleanup | route authority or deployment registry |
| `audio.rs` | STT/TTS transports, workers, bounds, deadlines | project selection or persistence policy |
| `display.rs` | the stage projection (`DisplayProjection`), the display gate state, and the display-precedence rule for `/view` and the snapshot | generation checks, HTTP/WebSocket handling |
| `delivery.rs` | the event envelope, per-connection framing (`DeliveryState`), and the ordered audio queue | route authority, generation checks |
| `models.rs` | catalog parsing and spoken model/thinking resolution | where catalogs come from |
| `registry.rs` | the project registry and spoken-name resolution | agent reasoning |
| `history.rs` | transcript storage shape | deciding when a turn routes |
| `visual_protocol.rs` | display action validation and normalization | layout |
| `protocol.rs` | the shape of every message sent to the browser (`ServerMessage`) and every command it sends (`ClientMessage`) | when or to whom a message is sent; what a command does |
| `debug.rs` | bounded, in-memory observation: the event and log rings, the debug schema (`DebugEvent`), record scrubbing and clipping, and the debug listener's router and WebSocket framing | call control, routing or lifecycle decisions, awaiting on clients or doing I/O while publishing, disk history |
| `apps/frontend/` | capture, protocol client, playback, UI | server authority or durable state |
| `extensions/` | the operator's Pi-side tool signal | direct route mutation |
| homelab | deployment and secrets | application implementation |

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

A streaming worker's partial results are logged and go no further: they are
not shown, persisted, routed, steered, or spoken. The page has no place for a
caller line that is still being recognized, so the service does not send
them. A final result may be claimed only once. A failed or abandoned
stream must either complete through the complete-clip contract or report a bounded,
visible failure; it must not silently create a duplicate turn.

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
- stale result: generation gate discards it without side effects
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

- `apps/backend/src/api.rs` is still a thick application coordinator: HTTP and
  WebSocket handling, turn dispatch, and the workers that drive `display.rs`
  and `delivery.rs` through their own public methods. It no longer holds the
  display projection or the audio queue directly -- those moved to
  `display.rs` and `delivery.rs` (#60).
- The display precedence rule is implemented twice, in `DisplayProjection`
  (`display.rs`, for `/view` and the snapshot) and in the browser's
  `sceneModel.ts`, on purpose: the server answers `/view` without asking the
  browser, and the browser renders without a round trip. This is now a
  checked duplication rather than an unchecked one: both are held to
  `apps/frontend/tests/fixtures/display-precedence.json`, read by a Rust test
  in `display.rs`'s tests and a vitest test, so the two rules cannot drift
  apart unnoticed.
- `apps/frontend/src/runtime/callRuntime.ts` still coordinates several
  concerns (socket lifecycle, outbox, line requests, hands-free wiring); the
  recorder and playback are separate modules, the rest is one class.
- browser event variants and Rust delivery events are intentionally coupled at
  the wire boundary.
- `Speaker` still contains ElevenLabs-specific request policy.
- `PiSession::collect` still represents a settlement boundary, so model-text to
  TTS streaming requires a deliberate Pi event-stream extension.

These are known tradeoffs, not invitations to create abstractions everywhere.
Extract a new port when a feature needs substitution, concurrency isolation, or
a test seam. Otherwise prefer the existing owner and the smallest change.
