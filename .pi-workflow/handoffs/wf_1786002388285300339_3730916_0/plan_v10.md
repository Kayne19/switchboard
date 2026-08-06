# Handoff Output: plan_v10
Status: success
Verdict: (none)
Timestamp: 1786008133

## Content
# plan_v10: final implementation-ready plan

## Scope and approved decisions

Planning only. Implementation may edit Rust, TypeScript extensions/browser sources, tests, documentation, and committed `static/`. Do not edit `legacy/`, homelab/deployment files, secrets, or source during this planning task.

The remote SSH policy is closed and must not change:

- SSH `keep_context=true` redial closes/reaps the local child, returns `remote_shutdown_unverified`, settles to operator, starts no candidate, and never reuses the session ID.
- No remote lock, flock, lock-file, or “wait for SSH teardown” workaround.
- `keep_context=false` may start a new-session candidate after local teardown.

## Ordered implementation slices

### 1. Establish singular lifecycle ownership

In `src/pbx.rs`, add:

- `CallLifecycle`
- `LifecyclePhase::{Operator, Active, Candidate, Quiescing, ShuttingDown}`
- `LegIdentity { leg_token, generation }`
- `OperationIdentity`
- `CandidateLeg`
- `Coordinator`
- `CatalogSnapshot`
- `ExtensionStageTxn`

`CallLifecycle` exclusively owns route, project, persistent session ID, process leg token, generation, phase, requested/effective model and thinking, activity clock, and terminal reason.

`Switchboard` retains registry, configuration, process resources, adapters, staging transactions, and catalog loading only. Remove lifecycle mirrors from `Switchboard`, `LiveLegState`, and `AppInner`.

`Coordinator` commands are the only lifecycle mutation path:

- `begin_operation`
- `finish_operation`
- `accept_callback`
- `begin_rescue`
- `adopt_candidate`
- `settle_operator`
- `return_if_idle`
- `begin_shutdown`
- `finish_shutdown`
- `status_snapshot`
- `touch_activity`

Each command linearizes under the short-lived coordinator lock `C`. No command awaits while holding `C`.

### 2. Lock ownership and status projection

Use these owners and rules:

| Lock/state | Owner | Rule |
|---|---|---|
| Lifecycle | `Coordinator`, `C` | All route, token, generation, phase, model, thinking, activity mutations |
| PBX resources | `Switchboard`, `P` | Process handles, registry, staging transactions, catalog loading |
| Catalog view | immutable `Arc<CatalogSnapshot>` | Independently readable; never read through `P` |
| Delivery | `DeliveryState`, `D` | Connections, writers, audio reservations, event sequencing |
| Transcript | `TranscriptLog`, `T` | Never held while awaiting PBX/process work |
| Diagram | `last_diagram`, `G` | Never held while awaiting PBX/process work |

Allowed nested order is `C -> D -> T -> G`. `P` is never acquired while another listed lock is held, and no listed lock is acquired while holding `P`.

`CatalogSnapshot` contains catalog revision, project key, immutable model entries, availability, and diagnostic. Catalog loading happens under `P`; the fully loaded snapshot is published before candidate lifecycle adoption. Status reads lifecycle through `Coordinator::status_snapshot`, then clones the independently published catalog pointer without taking `P`.

Freshness semantics:

- A status response is a coherent point-in-time lifecycle snapshot plus the newest catalog snapshot published for that lifecycle project.
- A catalog whose project key does not match the lifecycle project is represented as unavailable/not loaded, never projected for the wrong project.
- Old and new catalog snapshots are both valid during refresh; no status request blocks on catalog loading.
- Publication order is catalog snapshot publication, then candidate adoption. Failed candidates may leave only an unpublished/non-current snapshot, never visible as current catalog state.

Remove `AppInner::status_snapshot`, cached `Value` status arguments, and `Switchboard::status()` reads that require `P`. All `/status`, `/healthz`, `/leg-state`, page responses, route events, and WebSocket snapshots use fresh projection.

Tests in `src/api.rs` and `src/pbx.rs` must hold a fake `P` gate while asserting `/status`, `/leg-state`, and `/speak` complete within a timeout and return coherent route/catalog data.

### 3. Correlate callbacks without invented ExtensionAPI metadata

Inspection establishes the real API:

- `ExtensionAPI` tool handlers receive `execute(toolCallId, params)`.
- Current extension callbacks do not receive Pi operation metadata.
- Current request bodies are:
  - `/leg-state`: `{ "thinking": string, "token": string }`
  - `/speak`: `{ "text": string, "token": string }`
  - `/diagram`: `{ "source": string, "title": string, "notes": string, "token": string }`

Do not add `toolCallId` to callback bodies and do not claim Pi supplies operation IDs.

Callbacks are leg-scoped:

1. `Coordinator::begin_operation` registers one internal operation before `PiSession::prompt` or `PiSession::steer`.
2. The operation remains active until `PiSession::collect` observes `agent_settled` and `finish_operation` runs.
3. A per-process `leg_token` identifies the process. It is present in extension environment and all callback bodies.
4. Only one prompt/steer operation may exist per process; `PiSession`’s turn lock enforces this.
5. `accept_callback(token, kind)` succeeds only when the token is the current adopted leg token, lifecycle phase is `Active`, and the registered operation is active.
6. Operator callbacks, candidate callbacks, quiesced callbacks, stale tokens, callbacks with no active operation, and callbacks after `agent_settled` are rejected with bounded non-success responses and have no lifecycle, transcript, audio, diagram, activity, or status effect.
7. Candidate tokens are never published as current and are never buffered.

Keep Pi JSONL command bodies unchanged:

- prompt: JSON object with `type: "prompt"` and `message`, newline terminated.
- steer: JSON object with `type: "steer"` and `message`, newline terminated.

In `src/pi_client.rs::{Signal,Turn,PiSession::collect}`, retain `toolCallId` from `tool_execution_start`. For `speak`, require a matching `tool_execution_end` with the same `toolCallId` and `isError == false` before `Turn::agent_spoke()` is true. Missing IDs, start-only events, failed ends, mismatched ends, and late ends do not count. Routing signals retain their existing event semantics, but speech fallback uses only successful completed speech.

Tests:

- `tests/test_extensions.mjs`: assert the exact three request bodies above and assert the execute argument is not forwarded as invented metadata.
- `src/pi_client.rs`: successful matching ID, start-only, failed end, mismatched ID, missing ID, and late end.
- `src/api.rs`: no-active-operation, stale-token, candidate-token, post-settlement, and concurrent-operation rejection.

### 4. Candidate staging is a transaction

Replace host-wide cached `Option<String>` staging with candidate-owned `ExtensionStageTxn`:

- unique candidate artifact path under a dedicated candidate namespace;
- host, remote path, cache key, candidate token, and cleanup state;
- no insertion into adopted host cache until successful adoption.

`start_agent` creates the transaction, stages remotely, and associates the returned path only with the candidate. Startup failure, intro failure, rescue, cancellation, timeout, and adoption failure all execute cleanup:

1. close/reap candidate process;
2. delete the candidate remote artifact;
3. invalidate the candidate cache entry;
4. record bounded cleanup diagnostics;
5. settle operator if cleanup or adoption failure prevents a safe state.

Remote staging must write a temporary candidate file and atomically publish its candidate path. Cleanup targets only that candidate namespace. Startup performs a bounded sweep of stale candidate artifacts and invalidates all in-memory candidate cache entries. Stable adopted artifacts are not swept.

A cleanup transport failure is explicitly documented as `stage_cleanup_unverified`; the artifact is not reusable, the cache entry is invalidated, and startup sweep retries removal. No unadopted artifact is treated as usable.

Candidate callbacks and effects remain rejected until atomic `adopt_candidate` succeeds. Intro output is retained privately and published only after adoption. Candidate thinking reports are private.

Tests in `src/pbx.rs`:

- staging succeeds, intro fails: remote delete and cache invalidation;
- process startup failure: cleanup;
- rescue during intro: cleanup;
- cancellation during staging: cleanup;
- adoption failure: cleanup and operator settlement;
- cleanup failure: invalid cache and bounded diagnostic;
- startup sweep removes stale candidate artifacts;
- adopted candidate retains only its owned artifact.

### 5. Lifecycle transitions, idle, shutdown, and fail-closed redial

`transfer`, `redial`, `start_agent`, `drop_agent`, `force_hangup`, and `shutdown` in `src/pbx.rs` must use coordinator commands and never mutate lifecycle fields directly.

Rescue linearization:

1. `begin_rescue` under `C` marks the old leg `Quiescing`, increments generation, rejects callbacks, and returns a resource-close plan.
2. Close and reap old resources under `P`, without `C`.
3. For local/fake same-session redial, start a candidate only after zero old-process overlap.
4. For current SSH same-session redial, return `remote_shutdown_unverified`, perform no candidate startup, do not touch the persistent session file, and `settle_operator`.
5. For a new session ID, stage/start candidate and adopt only after startup and intro succeed.

`spawn_idle_worker` in `src/api.rs` only polls and sends `Coordinator::return_if_idle { now, timeout }`. The command linearizes under `C`; it checks current route, last activity, no active operation, and no candidate. If eligible, it marks `Quiescing`, increments generation, and returns the close plan. Resource closure then occurs under `P`. Successful idle return emits the existing spoken/transcript notification and a terminal lifecycle event; failed closure settles operator.

`api::shutdown` ordering:

1. `Coordinator::begin_shutdown` under `C`: mark `ShuttingDown`, increment generation, reject callbacks, and return active-operation cancellation handles.
2. `DeliveryState` under `D`: cancel reservations, retire writers, and enqueue one terminal JSON event `{"type":"terminal","reason":"shutdown"}` through the writer path.
3. Abort active turn/speech tasks and await their cancellation.
4. Close/reap PBX resources under `P`.
5. `Coordinator::finish_shutdown` marks terminal state.
6. No callback or late task can mutate state after this point.

Tests cover idle linearization against a simultaneous turn, shutdown against a callback, callback rejection after shutdown, terminal event ordering, task cancellation, leg quiescence, and zero process overlap.

### 6. WebSocket registration barrier and one writer path

`DeliveryState` owns `Connection` and `Writer` records. Each connection has a monotonically allocated `connection_epoch`, bounded writer queue, cancellation signal, snapshot cursor, and barrier state.

Registration and snapshot:

1. WebSocket upgrade allocates epoch and registers the connection in `DeliveryState` before reading snapshot state.
2. The registered connection is marked `SnapshotBarrier`.
3. Events published after registration are assigned monotonically increasing event sequence numbers and buffered for that connection.
4. Snapshot data is collected in exact order: epoch, status, history, diagram.
5. The writer receives one snapshot command, then a barrier-release command carrying the cursor.
6. Release drains buffered events in sequence order and changes the connection to live mode.
7. Events from before registration are not replayed.

Only the writer task calls `WebSocket::send`. Pong replies, command errors, snapshot JSON, broadcast JSON, audio metadata, binary audio, and shutdown messages all use the same writer queue. The reader only parses input and submits writer commands or application commands.

Replacement/disconnect:

- registering a new connection retires the previous active connection under `D`;
- old reservations are canceled and old writer shutdown is requested;
- old-reader cleanup checks its epoch before retiring anything, so it cannot cancel the replacement;
- disconnect retires only the matching epoch;
- writer queue saturation deterministically retires that connection, cancels its reservations, and drops ephemeral audio;
- broadcast lag retires/resets the affected connection; reconnect obtains the authoritative snapshot.

Exact wire contracts remain:

- JSON metadata frame followed by binary audio frame;
- newline-delimited Pi JSONL RPC;
- reconnect order `epoch -> status -> history -> diagram`.

Tests in `src/api.rs` and `tests/test_protocol.mjs` cover registration-before-snapshot, live event buffering, cursor release, replacement, stale-reader cleanup, disconnect cancellation, lag, queue saturation, pong/error ordering, exact audio framing, and reconnect ordering.

### 7. Speech deadline and audio commit

Define one canonical constant: `SPEECH_DEADLINE = 25 seconds`.

Use it in:

- `extensions/agent-switchboard.ts`: `AbortSignal.timeout(25_000)`;
- `src/api.rs::speak`: deadline starts at HTTP admission;
- `SpeechRequest`: absolute deadline, generation, connection epoch, sequence, cancellation, and acknowledgement;
- `process_speech`: deadline-aware TTS and queue admission;
- `src/audio.rs::{Speaker::synthesize,HttpTtsTransport::send}`: remaining deadline;
- writer enqueue and final audio commit.

The callback request bodies remain exactly `{text, token}`. Deadline is internal transport state, not invented Pi metadata.

`/speak` validates the current token and active operation before reserving audio. It returns success only after TTS succeeds, identity remains current, reservation commits, and the current writer accepts the audio metadata/binary pair.

Failure behavior:

- blank text: `400`;
- stale/candidate/no-active operation: bounded `409`;
- no browser: non-success response containing `{"delivered":false,"reason":"no browser connected"}`;
- queue full: `503`;
- TTS failure: `502`;
- deadline: `504`;
- worker drop/shutdown: `503`.

The extension marks every non-2xx speech response and `delivered:false` as `isError:true`, so written fallback remains eligible. Only acknowledged delivery returns successful tool content.

Every reservation has one terminal transition: committed, canceled, timed out, worker-dropped, stale, disconnected, or queue-rejected. Cancellation occurs on HTTP handler drop, extension abort, timeout, TTS failure, stale generation, stale connection epoch, writer loss, worker shutdown, or disconnect. Late TTS results cannot commit.

Tests:

- timeout wins versus commit while holding `D`;
- commit wins just before deadline;
- delayed TTS after cancellation produces no audio;
- queue-full response cancels reservation;
- worker drop finalizes reservations;
- reconnect cancels old-epoch speech;
- later audio is not wedged behind canceled earlier audio;
- failed speech does not suppress written fallback.

### 8. Browser races, model passthrough, documentation, and compatibility

In `web/app.ts` and `web/protocol.ts`:

- serialize audio playback ownership and pending `play()` attempts;
- teardown playback owner before exactly-once requeue;
- distinguish setup pauses from user pauses;
- handle both `pause -> ended` and `ended -> pause`;
- ignore stale native-player callbacks and control clicks;
- reset reverse-seek terminal state;
- finalize recorder `onstop` before a new recording;
- remove stale clips from the outbox using ID-bearing errors;
- serialize model picker requests;
- preserve additive protocol types and accepted-clip idempotency.

`tests/test_app.mjs` and `tests/test_protocol.mjs` use deferred promises for playback, reconnect, recorder, picker, and outbox races. Rebuild committed `static/`.

In `src/models.rs::ModelCatalog::resolve`:

- available catalogs retain exact/provider-qualified matching and ambiguity rejection;
- unavailable catalogs accept only provider-qualified `provider/model[:thinking]` after `parse_spec` and thinking normalization;
- unavailable catalogs reject bare names;
- returned model specs remain provider-qualified.

Add tests for unavailable-catalog passthrough, bare-name rejection, thinking normalization, and legacy parity.

Update:

- `README.md`
- `docs/rust-typescript-migration-handoff.md`
- `docs/concurrency-and-test-hazards.md`
- `docs/observability-and-coverage-handoff.md`

Document callback leg scoping, operation lifetime, status/catalog freshness, lock order, candidate rollback, fail-closed SSH redial, speech fallback, WebSocket barriers, and the homelab deployment boundary.

## File and symbol map

- `src/pbx.rs`: `CallLifecycle`, `Coordinator`, lifecycle commands, `CandidateLeg`, `ExtensionStageTxn`, `CatalogSnapshot`, `Switchboard::{transfer,redial,start_agent,drop_agent,force_hangup,shutdown}`, `stage_extension`, `upload_extension_with`, `load_catalog`, `status`, activity and route callbacks.
- `src/pi_client.rs`: `PiSession::{prompt,steer,collect,close}`, `Signal`, `Turn`, `agent_spoke`, JSONL event parsing, process quiescence.
- `src/api.rs`: `AppInner`, `DeliveryState`, `Connection`, `Writer`, `SpeechRequest`, reservation finalization, `speak`, `process_speech`, `websocket`, `send_snapshot`, `emit`, `handle_text_frame`, `handle_audio_frame`, `spawn_idle_worker`, `shutdown`.
- `src/audio.rs`: `Speaker::synthesize`, `HttpTtsTransport::send`, deadline-aware cancellation.
- `src/models.rs`: `ModelCatalog::resolve`, unavailable catalog passthrough.
- `extensions/agent-switchboard.ts`: `SESSION_TOKEN`, exact callback bodies, 25-second speech abort, speech failure result.
- `web/app.ts`, `web/protocol.ts`: playback, recorder, outbox, picker, reconnect races.
- `tests/test_extensions.mjs`, `tests/test_app.mjs`, `tests/test_protocol.mjs`.
- Documentation files listed above.
- No `legacy/` or homelab files.

## Rejected alternatives

- Invented ExtensionAPI operation metadata or forwarding `_toolCallId` in HTTP bodies.
- Correlating speech from `tool_execution_start` alone.
- Nested `P` and `C` locks or status reads through `Switchboard::status`.
- Cached status `Value` publication.
- Direct WebSocket sends from the reader or multiple writer paths.
- Treating broadcast receiver count as connection identity.
- Reusing candidate host cache before adoption.
- Leaving failed remote artifacts or stale cache entries reusable.
- Remote SSH locks, flock, lock files, or same-session reuse after unverified shutdown.
- Independent speech deadlines, uncanceled reservations, or late TTS commits.
- Durable audio queues, Redis, databases, or homelab deployment edits.

## Acceptance commands

```text
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm test
git diff --exit-code -- static
```

Live validation remains limited to real SSH/Pi shutdown acknowledgement, extension event ordering, browser media timing, STT/TTS services, credentials, and the separate homelab pinned-tag deployment.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Final plan closes review_v9 blockers with explicit callback leg scoping, immutable catalog projection, WebSocket barrier and writer ownership, candidate staging rollback, Coordinator idle/shutdown commands, and a shared 25-second speech deadline."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository, plan_v9, review_v9, prior contracts, and concurrency-hazard inspection",
      "result": "passed",
      "summary": "Verified current ExtensionAPI execute signature, callback payloads, Pi JSONL events, staging, status locks, WebSocket paths, idle/shutdown callers, and speech transport."
    },
    {
      "command": "cargo fmt --all -- --check; cargo test --locked; cargo clippy --locked --all-targets -- -D warnings; python3 -m unittest discover -s legacy/tests; npm test; git diff --exit-code -- static",
      "result": "not-run",
      "summary": "Implementation and verification are outside this planning-only task."
    }
  ],
  "validationOutput": [
    "Current callbacks carry token but no operation metadata.",
    "Current Pi events carry toolCallId and isError, while PiSession does not yet retain them for speech correlation.",
    "Current status reads catalog state through Switchboard/P and current WebSocket sends directly from the reader.",
    "Current extension staging caches remote paths before candidate adoption.",
    "Current idle and shutdown callers bypass Coordinator.",
    "Current extension and TTS paths each use independent 30-second timeouts."
  ],
  "residualRisks": [
    "Real remote shutdown acknowledgement and Pi event ordering require host validation.",
    "Browser autoplay/media timing and external STT/TTS latency require hardware/service validation.",
    "Homelab pinned-tag deployment remains a separate review."
  ],
  "noStagedFiles": true,
  "diffSummary": "Planning-only final revision; no source files changed.",
  "reviewFindings": [
    "closed high: src/pi_client.rs, extensions/agent-switchboard.ts - callbacks use current in-flight operation plus per-process token without invented metadata",
    "closed high: src/api.rs, src/pbx.rs - immutable independently readable CatalogSnapshot avoids P/C nesting and preserves coherent fresh status",
    "closed high: src/api.rs, tests/test_protocol.mjs - registration barrier, cursor buffering, replacement, lag, and one writer path are explicit",
    "closed high: src/pbx.rs - candidate-owned staging transaction cleans remote artifacts and invalidates cache on every failure path",
    "closed medium: src/pbx.rs, src/api.rs - named Coordinator idle/shutdown commands and linearization are explicit",
    "closed medium: src/api.rs, src/audio.rs, extensions/agent-switchboard.ts - exact 25-second deadline propagates through cancellation and writer commit"
  ],
  "manualNotes": "No unresolved repository-scope planning blocker remains. The fail-closed SSH policy is preserved without reopening remote session reuse."
}
```

[38;2;136;136;136m✻ Turn took 4m 12s (Total time 4m 12s · 1 turn)[0m