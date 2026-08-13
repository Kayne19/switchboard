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
          +--> pbx.rs: leg and route lifecycle
          |       |
          |       +--> operator Pi process
          |       +--> project Pi process over SSH
          |
          +--> audio.rs: STT/TTS ports and adapters
          |       |
          |       +--> STT command or long-lived STT worker
          |       +--> ElevenLabs or local TTS transport
          |
          +--> history / registry / models / coordinator

web/ ---------------- browser protocol, capture, playback, rendering
static/ ------------- committed browser build output
extensions/ --------- Pi-side tool and callback adapters
legacy/ ------------- compatibility baseline, not the active Rust service
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

`src/pbx.rs` and the coordinator own:

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

`src/pi_client.rs` owns the process/RPC transport and session continuity. The
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

`src/api.rs` is the application boundary for HTTP, WebSocket, turn dispatch,
audio delivery, generation checks, and worker coordination. It may coordinate
these concerns, but it must not become the owner of provider-specific speech
protocols or Pi routing policy.

Important application behavior must remain visible through named operations,
events, or state transitions. Do not hide a route change, persistence action,
or cancellation side effect inside an unrelated helper.

### 4. Audio is an adapter boundary

`src/audio.rs` owns speech transport and worker mechanics:

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

`web/` owns:

- microphone permission and capture
- wake/VAD state when added
- WebSocket framing from the browser side
- audio playback and MSE fallback
- diagram rendering
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

The browser/server WebSocket protocol is defined in `web/protocol.ts` and its
Rust counterpart. Changes to message types, framing, MIME rules, sequence
numbers, generations, or environment variables are public contract changes.

Every protocol addition must define:

- owner and direction
- framing and size limits
- ordering and replay behavior
- cancellation behavior
- stale-generation behavior
- legacy fallback
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
and `diagram` emit signals through the established callback/session contract.
The service decides what action those signals cause.

This separation keeps tools small, makes failures recoverable, and prevents an
agent from acquiring hidden authority over the switchboard.

### 9. Compatibility is an adapter, not a second architecture

`legacy/` is the compatibility baseline and test suite. It is not the design
center of the Rust service. New behavior should preserve the legacy contract
through an adapter or explicit fallback rather than duplicating the full
lifecycle in a second implementation.

The complete-clip `SWITCHBOARD_STT_COMMAND` contract remains valid while the
optional long-lived `SWITCHBOARD_STT_STREAM_COMMAND` contract is deployed and
benchmarked. Both sides of an environment contract must be changed together:
application here, deployment in homelab.

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

### 11. Prewarm and zero transfer-time setup

`src/prewarm.rs` owns startup prewarming for SSH transports, model catalogs, extension staging digests, and project prepare commands:

- **No resident project Pi at startup**: Project Pi processes launch on call transfer; they are not resident at startup.
- **Asynchronous prewarm**: Startup prewarming runs asynchronously before worker spawning, establishing master SSH connections, fetching in-memory model catalog snapshots per `CatalogKey`, verifying extension digests (SHA-256, mode `0600`, atomic tmp files, LKG fallback), and executing project prepare commands (nonzero exit status or timeout produce terminal, timestamped report snapshots that are launchable and never retried).
- **Zero transfer-time setup**: Transfer paths consume prewarmed transport generations, catalog snapshots, extension staging decisions, and prepare reports. Live request-time SSH setup, extension uploads, prepare command execution, and catalog listings are bypassed during transfer.

### 12. Persistent SSH ownership and qualified model fallback

- **SSH Master Ownership**: Master SSH connections (`ControlMaster=yes`, `ControlPersist=no`) use deterministic lock (`<state_dir>/ssh/locks/<sha256>.lock`) and socket (`<state_dir>/ssh/control/<sha256>.sock`) paths under `SWITCHBOARD_STATE_DIR` protected by kernel `flock`. Master ownership is strictly preserved: only the process that created the master connection terminates master (`-O exit`) or child processes on shutdown; adopting processes release locks without signaling sibling control sockets. Injected client options set `ControlMaster=no` with explicit `ControlPath`.
- **In-Memory Catalog & Fallback**: Model catalogs are cached in memory per `CatalogKey` (`host`, `runtime`, list models argv). When catalog resolution is unavailable or unpopulated, provider-qualified model specs pass through cleanly, while bare model names fail closed with clear diagnostic errors.

## Ports and adapters

### Inbound adapters

- browser WebSocket audio/control frames
- browser HTTP controls such as connect, hangup, speak, and diagram
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
| `src/main.rs` | composition root and configuration wiring | turn policy |
| `src/api.rs` | HTTP/WebSocket coordination, workers, delivery, generation checks | provider wire formats, PBX policy |
| `src/pbx.rs` | leg lifecycle, transfer, return, rescue, redial | browser rendering or TTS encoding |
| `src/pi_client.rs` | Pi process/RPC transport and session continuity | route authority or deployment registry |
| `src/audio.rs` | STT/TTS transports, workers, bounds, deadlines | project selection or persistence policy |
| `src/registry.rs` | project/model catalog resolution | agent reasoning |
| `src/history.rs` | transcript/history storage shape | deciding when a turn routes |
| `web/` | capture, protocol client, playback, UI | server authority or durable state |
| `extensions/` | Pi-side tool/callback signals | direct route mutation |
| `legacy/` | compatibility behavior and tests | new Rust architecture |
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
  -> speak/diagram signal or completed-reply fallback
  -> TTS transport
  -> ordered audio events
  -> browser playback
```

Partial results must not be persisted, routed, steered, or spoken as if they
were final. A final result may be claimed only once. A failed or abandoned
stream must either complete through the legacy contract or report a bounded,
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

- `src/api.rs` is a thick application coordinator and knows several concrete
  audio/delivery structures.
- `web/app.ts` contains substantial capture, protocol, playback, and UI state.
- browser event variants and Rust delivery events are intentionally coupled at
  the wire boundary.
- `Speaker` still contains ElevenLabs-specific request policy.
- `PiSession::collect` still represents a settlement boundary, so model-text to
  TTS streaming requires a deliberate Pi event-stream extension.

These are known tradeoffs, not invitations to create abstractions everywhere.
Extract a new port when a feature needs substitution, concurrency isolation, or
a test seam. Otherwise prefer the existing owner and the smallest change.
