# Final implementation contract

## Status

This is the parent-synthesized, read-only implementation contract. It consolidates the full review ledger instead of relying on a planner to remember earlier revisions. No source files are changed by this artifact.

## Non-negotiables

- Rust remains the running service; `legacy/` remains the compatibility baseline.
- Preserve existing HTTP/WebSocket/browser wire shapes, newline-delimited Pi JSONL, sentinel behavior, one-caller ephemerality, and reconnect ordering.
- No Postgres, Redis, run queue, durable lifecycle journal, homelab edits, secrets, or premature legacy deletion.
- Deployment changes remain a separate homelab PR.
- Current SSH same-session `keep_context=true` redial fails closed. After local SSH teardown, because the current protocol cannot verify remote shutdown, record `remote_shutdown_unverified`, start no candidate, do not reuse the persistent session ID, and settle to operator. Do not add a speculative remote flock/lock-file protocol.

## Invariant ledger

| ID | Invariant | Owner/mechanism | Required proof |
|---|---|---|---|
| L1 | One lifecycle authority | `CallLifecycle` owns route, project, persistent session ID, current leg token, generation, phase, model/thinking, activity, operation state | No lifecycle mirrors in `Switchboard` or `AppInner`; coordinator ownership tests |
| L2 | No stale work commits | Every transcript, steer, reply, audio, diagram, status, and terminal commit checks leg token plus generation; browser clip work also checks recording turn epoch | Rescue/transfer/redial/STT/turn race tests |
| L3 | Candidate adoption is atomic | Candidate process, token, startup state, intro, and staging are private until one adoption command | Failure/rescue/intro tests prove no project-visible state or side effect |
| L4 | Candidate effects are private | Candidate speech/diagram/activity/status are rejected; startup thinking is the only controlled exception and is stored only in candidate startup state | Callback endpoint tests and thinking adoption tests |
| L5 | Same-session SSH reuse is safe | Current adapter never reopens an unverified remote session | `remote_shutdown_unverified`, zero candidate starts, operator settlement |
| L6 | Speech success is real delivery | Success requires TTS, current identity, writer acceptance, and committed audio; tool speech requires matching successful end event | timeout, queue-full, stale, worker-drop, and fallback tests |
| L7 | Audio cannot wedge | Every reservation reaches one terminal state; stale/disconnected/queue-full reservations are finalized | reconnect and timeout-versus-commit tests |
| L8 | Status is coherent and nonblocking | Fresh immutable projection combines lifecycle and matching catalog publication without taking PBX lock | lock-contention and publication-order tests |
| L9 | WebSocket snapshot is ordered | One writer owns every outbound frame; registration cursor buffers live events until `epoch,status,history,diagram` snapshot completes | writer/barrier/replacement tests |
| L10 | Diagnostics are bounded | Separate `DiagnosticTrace` owns process-global sequence and 256-entry ring; lifecycle only emits sanitized records | UTF-8, size, retention, secret-exclusion tests |
| L11 | Model compatibility remains | Unavailable catalog accepts qualified specs and preserves thinking suffix; populated catalog/picker behavior remains compatible | Rust, browser, and legacy parity tests |
| L12 | Existing browser stale protocol remains | Recording-start epoch, clip IDs, outbox removal, stale transcript/steer/queue checks remain | `docs/concurrency-and-test-hazards.md` tests |

## Ownership and synchronization

### Owners

- `CallLifecycle`: route, project, persistent session ID, adopted leg token, generation, phase, model/thinking, last activity, current operation identity, terminal reason, and lifecycle transition logic.
- `Coordinator`: the short synchronous `linearize` boundary around `CallLifecycle`. It never awaits, broadcasts, calls SSH, or invokes external callbacks while state is held.
- `CandidateLeg` and `PiSession`: process resources, stdin/stdout/stderr, staging transaction, startup result, intro result, and process cleanup. They do not mutate route state.
- `Switchboard`: immutable configuration, registry, validated SSH target data, adapter dependencies, process launch configuration, and catalog loading. It is an async facade, not a second lifecycle owner. Every SSH command path (`remote_argv`, `list_models_argv`, `run_prepare`, and `upload_extension_with`) must accept a `ValidatedSshTarget`, never a raw host. The shared validator rejects empty/overlong hosts, leading-dash option-like hosts, control characters, shell metacharacters, and values that cannot be passed as one SSH argument; all four callers use the same constructor and return bounded validation errors. Add tests for normal hosts, leading dashes, whitespace/control characters, shell metacharacters, and each caller.
- `DeliveryState`: WebSocket connections/writers, connection epochs, audio reservations, and outbound sequence/barrier state. It owns no lifecycle generation. Reservations carry a captured `LegIdentity` only.
- `TranscriptLog` and diagram state: their existing bounded stores, never held across process or network awaits.
- `CatalogPublication`: immutable catalog snapshots and a single atomic publication pointer. Catalog loading may use PBX resource coordination, but status never waits for catalog loading.
- `DiagnosticTrace`: process-global monotonic sequence and bounded ring. `CallLifecycle` submits already-bounded records.

### Lock rules

`C` is the coordinator state lock, `D` is delivery state, and `P` protects PBX/process resource mutation. Transcript and diagram locks are `T` and `G`.

- `C` is held only for synchronous state transitions.
- `P` is never acquired while holding `C`, `D`, `T`, or `G`; no listed lock is acquired while holding `P`.
- A delivery commit uses one fixed short transaction `C -> D`: it checks the authoritative identity and reservation state, then commits or cancels the reservation before releasing either lock. No `D -> C` path exists.
- `T` and `G` are updated after identity validation and are never held during PBX, TTS, or WebSocket awaits.
- Status reads an atomic immutable `StatusProjection`; it does not acquire `P`, and `/speak`, `/leg-state`, and `/status` remain responsive while a turn holds PBX resources.
- `PiSession::steer` is not claimed to be protected by the prompt turn mutex. The coordinator attaches steer to the existing active prompt operation; it does not create a competing operation or falsely reject legitimate interruption.

Tests deliberately hold each existing resource gate and assert callback/status liveness, plus a lock-order/deadlock timeout test.

## Coordinator and operation contract

Commands include `begin_prompt`, `attach_steer`, `finish_operation`, `accept_callback`, `adopt_candidate`, `begin_rescue`, `return_if_idle`, `begin_shutdown`, `finish_shutdown`, `touch_activity`, `publish_catalog`, and `status_snapshot`.

- `begin_prompt` registers one internal `OperationIdentity` before calling `PiSession::prompt`.
- `attach_steer` requires the current adopted leg and an active prompt operation, and returns that same operation identity. It does not pretend `steer` is serialized by the prompt mutex.
- Callback requests carry only the real per-process `leg_token`; no invented ExtensionAPI operation metadata is added.
- Normal callbacks are accepted only for the current adopted token, `Active`/`TurnRunning` phase, and the registered active operation. There is at most one prompt operation per adopted process.
- `session_start` thinking is a startup-state report, not a turn callback. During `Starting`/`Intro`, a token matching the current candidate may update only `CandidateLeg.startup_thinking`; it cannot write status, activity, transcript, diagram, audio, or public thinking state. Once adopted, the staged value is promoted atomically. Invalid or late startup reports are rejected.
- Candidate speech, diagram, activity, and status callbacks are rejected with bounded non-success responses and never buffered.
- `PiSession::collect` retains `toolCallId` from speech `tool_execution_start`; `Turn::agent_spoke` becomes true only for a matching `tool_execution_end` with `isError == false`. Start-only, failed, missing, mismatched, and late ends do not suppress written fallback.

## Candidate adoption and staging

`CandidateLeg` owns a unique candidate token, process, session ID, startup thinking, intro output, and `ExtensionStageTxn`.

1. Prepare and stage into a candidate-only remote namespace.
2. Startup and intro run without changing visible route/project/model/session state.
3. Candidate callbacks follow the rules above.
4. One coordinator adoption command commits route, project, model, session ID, token, generation, phase, startup thinking, and the candidate's catalog publication.
5. Only after adoption may old-leg cleanup and public intro publication occur.
6. Any startup, intro, rescue, timeout, cancellation, or adoption failure closes/reaps the candidate, deletes its staged artifact, invalidates its cache entry, and settles to the prior leg or operator.
7. Cleanup failure records `stage_cleanup_unverified`; the artifact is never reused and a bounded startup sweep retries it.

The staging transaction never inserts a candidate result into the adopted host cache before adoption. Tests cover every failure point and assert no remote artifact or reusable cache entry remains.

## Redial, rescue, idle, and shutdown

- Rescue first marks the adopted leg `Quiescing`, increments generation, and rejects callbacks under `C`; resource closure then occurs outside `C`.
- SSH `keep_context=true` performs local close/reap, records `remote_shutdown_unverified`, starts no candidate, never reuses the session ID, and settles operator.
- `keep_context=false` or a new session ID may use the candidate path and atomic adoption.
- `spawn_idle_worker` only sends `Coordinator::return_if_idle`; it does not lock PBX and mutate route directly. The command requires operator/project eligibility, no active operation, no candidate, and an expired activity deadline.
- Shutdown is `begin_shutdown` under `C`, cancellation/finalization of delivery reservations under `D`, task cancellation and awaiting outside lifecycle state, PBX resource close under `P`, then `finish_shutdown`. Idle and shutdown emit ordered terminal events and reject late callbacks.

## Browser stale-work and WebSocket contract

### Browser turn epochs

Preserve the existing hazard contract: stamp a recording-start epoch in the clip header, increment/invalidate it on rescue, and check it before transcript persistence, steering, queued turn dispatch, reply/audio delivery, and retry. When `process_clips` rejects a stale clip, it must emit the existing ID-bearing error/ack path with the clip ID and a bounded `stale_epoch` code; it must never silently drop the clip. `web/app.ts` removes exactly that matching outbox entry and does not retry it after reconnect. Also filter an invalidated clip before any reconnect retry. No pre-rescue clip may be persisted or acted on after invalidation. Add rescue-then-disconnect/reconnect tests proving stale outbox removal.

### WebSocket

`DeliveryState` owns a `Connection` with `connection_epoch`, writer task, bounded queue, snapshot cursor, barrier state, and cancellation token.

1. Allocate/register the connection before reading its snapshot.
2. Assign sequence numbers to events after registration and buffer them for the barriered connection.
3. Writer sends exactly `epoch`, `status`, and `history`, then sends `diagram` only when the existing server has a diagram to send; there is no placeholder diagram frame. It then releases the captured cursor and drains buffered events in sequence order. Tests cover both absent- and present-diagram snapshots without changing the existing wire shape.
4. The reader never calls WebSocket send directly. Pong, command errors, JSON events, audio metadata, binary audio, and shutdown all enter the same writer.
5. Replaced/disconnected readers can retire only their own epoch. Retirement cancels its reservations and writer; lag or queue saturation retires the connection and requires reconnect snapshot.
6. Preserve JSON metadata followed by binary audio, newline JSONL Pi RPC, and existing browser event names/order.

Add deferred-promise tests for registration/live-event races, replacement cleanup, stale reader cleanup, lag, queue-full behavior, exact audio framing, and reconnect ordering.

## Speech/audio contract

Define `SWITCHBOARD_SPEECH_DEADLINE_MS` once as an environment contract with default `25000`; parse it as a positive bounded integer and reject invalid/out-of-range values. Rust reads it for every speech path and passes the same value through `agent_env` to the extension, which uses it for `AbortSignal.timeout`. The same absolute deadline and cancellation token must cover `/speak`, `process_speech`, regular settled-reply `synthesize_reply_if_current`, and `Speaker`/`HttpTtsTransport`; no independent 30-second TTS timeout remains. Document the variable and require the corresponding homelab contract update if deployment overrides it.

The HTTP handler creates a cancellation token and drop guard. The absolute deadline is propagated through `SpeechRequest`, regular turn reply synthesis, TTS, reservation commit, and writer enqueue. Handler cancellation, extension abort, worker drop, timeout, stale identity, disconnect, and writer failure all cancel the relevant reservation or synthesis task. A late TTS result cannot commit or suppress written fallback. Tests cover `/speak` and normal settled replies with invalid configuration, deadline expiry, cancellation, successful completion, and bounded transport behavior.

`/speak` returns success only after TTS succeeds, `Coordinator::commit_delivery` validates generation/token and connection epoch, and the writer accepts the JSON-plus-binary audio pair. It returns bounded errors for stale/candidate/no operation, TTS failure, deadline, queue full, no browser, worker drop, and shutdown. The extension marks non-2xx and `delivered:false` as `isError`, preserving written fallback.

Every reservation ends exactly once as committed, canceled, timed out, stale, disconnected, worker-dropped, or queue-rejected. A timeout-versus-commit race is serialized by `C -> D`; the tests prove no late or duplicate speech and no wedge behind a canceled slot.

## Status, catalog, diagnostics, and model compatibility

- `status_snapshot`, `current_status`, and `publish_status` become stateless projection functions; they accept no caller-supplied cached `Value`.
- Catalog loading creates an immutable private `CatalogSnapshot`. It is not published until the same coordinator adoption transaction that makes its project/leg current. Failed candidates never publish catalog state.
- `CatalogPublication` and lifecycle state are combined into an immutable `StatusProjection` with matching project and generation metadata. The atomic pointer is refreshed after every lifecycle/catalog transition. If metadata does not match, status reports catalog unavailable rather than mixing old/new state.
- `DiagnosticTrace` owns a process-global sequence and 256-entry ring. Every field is UTF-8-safe and capped at 128 bytes; serialized diagnostic payloads are at most 2 KiB. Allow only phase/code/count/bounded labels. Exclude tokens, prompts, transcripts, stderr, paths, tool arguments, secrets, and raw environment values. Add direct retention, sequence, truncation, payload-size, and exclusion tests.
- Unavailable catalogs accept only provider-qualified `provider/model[:thinking]`, preserve normalized thinking suffixes during redial, and reject bare names. Populated catalogs retain ambiguity rules, and the browser picker retains a current model absent from a populated catalog. Add Rust/browser/legacy parity tests.

## Browser media and compatibility tests

Preserve and test playback ownership, deferred `play()` races, setup-vs-user pauses, `pause`/`ended` ordering, stale native callbacks, recorder `onstop`, reverse-seek reset, ID-bearing outbox errors, serialized model-picker requests, accepted-clip idempotency, and static rebuild. Update `tests/test_app.mjs`, `tests/test_protocol.mjs`, and `tests/test_extensions.mjs` without changing existing wire shapes.

## Files and docs

- Rust: `src/pbx.rs`, `src/api.rs`, `src/pi_client.rs`, `src/audio.rs`, `src/models.rs`.
- TypeScript/browser: `extensions/agent-switchboard.ts`, `web/app.ts`, `web/protocol.ts`, committed `static/`.
- Tests: focused Rust tests plus `tests/test_app.mjs`, `tests/test_protocol.mjs`, `tests/test_extensions.mjs`; retain all legacy tests.
- Docs: `README.md`, `docs/concurrency-and-test-hazards.md`, `docs/observability-and-coverage-handoff.md`, `docs/rust-typescript-migration-handoff.md`. Explain the environment deadline contract and separate homelab PR boundary. Correct the existing speak wording so suppression requires a matching successful `tool_execution_end`, not tool-start observation. Document `SWITCHBOARD_SESSION_TOKEN` as an opaque fresh per-process leg token distinct from the persistent Pi session ID, and state that it correlates callbacks but is not authentication.
- Do not edit `legacy/` or homelab files.

## Acceptance commands

```text
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm test
git diff --exit-code -- static
```

External validation remains real SSH/Pi shutdown behavior, STT/TTS latency, browser media timing, credentials, hardware, and homelab pinned-tag deployment.

## Stop conditions

Stop the slice and return to review if any existing wire shape changes, a stale epoch commits, a reservation reaches two terminal states, any candidate artifact remains reusable after failure, status blocks callback paths, SSH same-session reuse is attempted without verified shutdown, or any acceptance gate fails.
