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
          +--> lifecycle.rs: the coordinator -- call identity, phases, freshness
          |
          +--> pbx.rs: leg and route lifecycle
          |       |
          |       +--> operator Pi process
          |       +--> project Pi process, launched from a prewarm plan
          |
          +--> prewarm.rs: startup setup per host and project
          |       (SSH masters, model catalogs, staged extensions, prepare)
          |
          +--> audio.rs: STT/TTS ports and adapters
          |       |
          |       +--> STT command or long-lived STT worker
          |       +--> ElevenLabs or local TTS transport
          |
          +--> history / registry / models / visual_protocol

apps/backend/ ------- the Rust service (src/) and its tests (tests/)
apps/frontend/ ------ browser: call runtime (socket, capture, playback) and rendering
static/ ------------- committed browser build output
extensions/ --------- Pi-side tool and callback adapters
homelab ------------- deployment, secrets, registry, persona, systemd
```

The dependency direction is intentional:

- external transports enter through adapters
- application code owns lifecycle and policy
- agent processes do reasoning and tool use
- browsers render and capture but do not own authority
- deployment supplies contracts but is not hidden inside the application

## Core rules

### 1. Switchboard owns the call lifecycle

`apps/backend/src/pbx.rs` and the coordinator (`lifecycle.rs`) own:

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

`apps/backend/src/pi_client.rs` owns the process/RPC transport and session continuity. The
Pi process owns prompts, model responses, tool calls, and project work. It does
not own:

- which leg is active
- the project registry
- SSH lifecycle
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

The browser/server WebSocket protocol is defined in `apps/frontend/src/protocol.ts` and its
Rust counterpart. Changes to message types, framing, MIME rules, sequence
numbers, generations, or environment variables are public contract changes.

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

Pi extensions such as `transfer_to_project`, `return_to_operator`, `speak`,
and `display` emit signals through the established callback/session contract.
The service decides what action those signals cause.

This separation keeps tools small, makes failures recoverable, and prevents an
agent from acquiring hidden authority over the switchboard.

### 9. One implementation per lifecycle

A fallback is an adapter or an explicit refusal, never a second copy of the
lifecycle kept for "when the real one is absent". pbx.rs once carried a full
transfer-time setup path for a switchboard without prewarm. Production always
had prewarm, nothing ran that path on purpose, and two holes led back into it
anyway: an extension prewarm could not stage was uploaded live, and a redial
that could not reach prewarm opened its own SSH connection. A second
implementation is untested in the configuration that matters and silently
reachable in the one that does not.

The same holds across a contract. The complete-clip `SWITCHBOARD_STT_COMMAND`
contract and the optional long-lived `SWITCHBOARD_STT_STREAM_COMMAND` are two
explicit transports behind one adapter, with a stated fallback between them.
Both sides of an environment contract change together: application here,
deployment in homelab.

### 10. Deployment stays outside this repository

Homelab owns:

- systemd and runtime installation
- SSH configuration
- project registry
- persona and operator prompt
- secrets
- `SWITCHBOARD_*` environment files

This repository owns application behavior and extension source. A deployment
change requires a separate homelab change (e.g. pinning binary release tags/checksums).
Never place secrets or deployment workarounds here to make a local feature appear complete.

### 11. Prewarm owns launch setup

`apps/backend/src/prewarm.rs` does all of the setup a project leg needs, once,
at startup: the SSH master connection per host, the model catalog per host and
runtime, the staged extension per host, and each project's prepare command.

- **No resident project Pi at startup.** Project processes launch on transfer.
- **Launch plans, not setup.** A transfer or redial asks prewarm for a
  `LaunchPlan` (prepare report, catalog, extension or none, SSH options) and
  starts the process from it. Nothing else reaches the host at transfer time:
  no SSH setup, no upload, no prepare, no model listing.
- **Refusal, not fallback.** A host prewarm cannot vouch for is a refused
  transfer or redial, and a live leg keeps running. An extension that could
  not be staged means the leg launches without one and its brief tells it to
  use the return sentinel.
- **Settled once.** Prepare results (success, nonzero, or timeout) are
  timestamped reports that are launchable and never retried.

### 12. Persistent SSH ownership and model fallback

- **SSH master ownership.** Master connections (`ControlMaster=yes`, `ControlPersist=no`) use deterministic lock (`<state_dir>/ssh/locks/<host hash>.lock`) and socket (`<state_dir>/ssh/control/<host hash>.sock`) paths under `SWITCHBOARD_STATE_DIR`, protected by kernel `flock`. Only the process that created a master terminates it (`-O exit`) or its children on shutdown; an adopting process releases its lock without signaling a sibling's control socket. Client commands set `ControlMaster=no` with an explicit `ControlPath`.
- **Model fallback is model policy.** Prewarm reports a catalog that could not be listed as unavailable, with its reason; it does not decide what that admits. `ModelCatalog::resolve` in `models.rs` does: a provider-qualified spec passes through, a bare name is refused.

## Ports and adapters

### Inbound adapters

- browser WebSocket audio/control frames
- browser HTTP controls: connect, hangup, thinking, and model
- agent callbacks: speak, leg-state, display, and view
- Pi RPC events and tool signals
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

- `PiSession` and SSH-launched project agents
- `SttAdapter` and `SttStreamAdapter`
- `TtsTransport` and ElevenLabs HTTP streaming
- WebSocket delivery and browser binary/text frames
- history and registry storage
- homelab-provided environment contracts

## Package responsibilities

| Area | Owns | Must not own |
|---|---|---|
| `apps/backend/src/main.rs` | composition root; `Config`, the only reader of the environment | turn policy |
| `api.rs` | HTTP/WebSocket coordination, workers, delivery, generation checks | provider wire formats, PBX policy |
| `lifecycle.rs` | call identity, phases, candidate legs, operations, the idle clock, the status projection | async work or I/O |
| `pbx.rs` | leg lifecycle: transfer, return, rescue, redial | host setup, browser rendering, TTS encoding |
| `prewarm.rs` | startup setup and launch plans: SSH masters, catalogs, staged extensions, prepare | routing decisions, model policy |
| `pi_client.rs` | Pi process/RPC transport, SSH command construction, process-tree cleanup | route authority or deployment registry |
| `audio.rs` | STT/TTS transports, workers, bounds, deadlines | project selection or persistence policy |
| `models.rs` | catalog parsing and spoken model/thinking resolution | where catalogs come from |
| `registry.rs` | the project registry and spoken-name resolution | agent reasoning |
| `history.rs` | transcript storage shape | deciding when a turn routes |
| `visual_protocol.rs` | display action validation and normalization | layout |
| `apps/frontend/` | capture, protocol client, playback, UI | server authority or durable state |
| `extensions/` | Pi-side tool/callback signals | direct route mutation |
| homelab | deployment and secrets | application implementation |

## Turn lifecycle

A normal voice turn should remain traceable as:

```text
capture
  -> WebSocket admission
  -> STT adapter / streaming worker
  -> partial transcript (display only)
  -> final transcript claim
  -> current-generation turn dispatch
  -> Pi session and tool loop
  -> speak/display signal or completed-reply fallback
  -> TTS transport
  -> ordered audio events
  -> browser playback
```

Partial results must not be persisted, routed, steered, or spoken as if they
were final. A final result may be claimed only once. A failed or abandoned
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

Failure ownership should be obvious:

- browser capture failure: browser reports it and releases the mic
- STT worker failure: audio adapter reports it; application decides fallback
- Pi/SSH failure: PBX returns the caller to the operator
- TTS failure: application reports it and preserves written-reply fallback
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

- `apps/backend/src/api.rs` is a thick application coordinator. Besides HTTP
  and WebSocket handling it holds the display projection and the audio queue,
  and knows several concrete audio/delivery structures.
- The current route is held in three places: `Switchboard.route`,
  `LiveLegState` (read by callbacks without the PBX lock), and the
  coordinator's lifecycle, which takes it from the status JSON the PBX
  publishes. Each transition keeps them in step by hand.
- The display precedence rule is implemented twice, in `DisplayProjection`
  (`api.rs`, for `/view`) and in the browser's `sceneModel.ts`. Tests pin both
  to the same rule.
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
