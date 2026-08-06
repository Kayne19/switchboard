# plan_v9: implementation-ready plan

## Scope

Planning only. Edit Rust, TypeScript extensions/browser sources, tests, and documentation. Do not edit `legacy/`, deployment, secrets, or homelab files. Rebuild committed `static/` output.

## Ordered implementation slices

1. **Make lifecycle ownership singular.**  
   In `src/pbx.rs`, add `CallLifecycle`, `LifecyclePhase`, `LegIdentity`, `OperationIdentity`, `CandidateLeg`, and `Coordinator`. `CallLifecycle` solely owns route, project, persistent session ID, real leg token, generation, phase, requested/effective model and thinking, and activity clock. Remove lifecycle mirrors from `Switchboard`, `LiveLegState`, and `AppInner`. `Switchboard` retains configuration, registry/catalog, staging, adapters, and process resources only. Add `src/diagnostics.rs::DiagnosticTrace` and export it from `src/main.rs`.

2. **Define ownership and lock order before moving callers.**

   | Concern | Owner | Lock/invariant |
   |---|---|---|
   | `CallLifecycle` | `Coordinator::{begin_operation, transition, adopt, settle, query}` | Short-lived `C`; all lifecycle mutations, idle worker, shutdown, rescue, transfer, redial, return, and hangup cross it |
   | `CandidateLeg`/`PiSession` | `CandidateLeg`, `PiSession` in `src/pbx.rs`/`src/pi_client.rs` | Candidate resources private; session turn/stdin/stdout locks never cross lifecycle commits |
   | Config/catalog/staging/adapters | `Switchboard`, `ModelCatalog`, SSH helpers | PBX resource lock `P`; never acquire `C` or `D` while holding `P` |
   | API transport/tasks/audio/WebSocket | `DeliveryState` in `src/api.rs` | Delivery lock `D`; per-connection writer exclusively owns socket |
   | `TranscriptLog` | `TranscriptLog` in `src/history.rs` | `T`; no lifecycle or PBX lock held while awaiting it |
   | Diagram/channel/session locks | diagram projection `G`, channel registry `H`, session-control `S` | Order `C -> D -> T -> G -> H`; `P` is isolated, never nested |
   | Diagnostics | `DiagnosticTrace` | One short record/snapshot lock; never held across await |

   `C -> D -> T -> G -> H` is the only nested order. No `P` while holding another listed lock, and no listed lock while holding `P`. Callback/status paths use only short `C`/`D` work or nonblocking channel sends, so they remain live while a turn owns `P`.

3. **Register operations and gate every identity-sensitive callback.**  
   Before every `PiSession::prompt` or `steer`, `Coordinator::begin_operation` records the real leg token, generation, and internal operation ID. Extend JSONL `prompt`/`steer` commands with exact generation and operation fields for internal correlation; do not claim `ExtensionAPI` exposes them. `extensions/agent-switchboard.ts` sends only the real `SESSION_TOKEN` as callback identity, plus endpoint data. `src/api.rs::{leg_state,speak,diagram}` validate token, current leg, phase, and active-operation state before any transcript, audio, diagram, status, or activity effect. Candidate callbacks are rejected with bounded errors; candidate effective thinking may be privately staged, never published. Late quiesced-leg activity is diagnostic-only and cannot mutate lifecycle.

4. **Implement transactional candidate adoption and fail-closed redial.**  
   Refactor `src/pbx.rs::{transfer,redial,start_agent,drop_agent,force_hangup,shutdown}` so candidate route/model/session/token state remains unpublished until startup and intro succeed, then adopts atomically through `Coordinator`. Candidate speech, diagram, activity, status, and thinking are rejected or privately staged. Candidate failure closes only candidate resources and leaves no partial publication.

   For local legs and deterministic fake adapters, `keep_context=true` may close/reap the old process before reopening its persistent session ID; tests assert process overlap is zero. For SSH legs, remove all remote FD/flock/lock-file schemes. `keep_context=true` may reopen only when a `RemoteShutdownAdapter` returns a verified shutdown acknowledgement. The current SSH/RPC adapter returns `remote_shutdown_unverified` after local SSH close/reap; it records a bounded diagnostic, settles to operator, and never starts a candidate or touches the persistent session file. `keep_context=false` uses a new session ID and may start a candidate after local teardown. Add tests for operator settlement, no candidate, no session-file reuse, no partial route/model/session publication, verified fake-adapter success, and zero overlap.

5. **Centralize and validate all SSH construction.**  
   In `src/pi_client.rs`, add `validate_ssh_inputs`, `validate_env_name`, `validated_ssh_argv`, and shell-command construction returning `Result`. Route `remote_argv`, `list_models_argv`, `src/pbx.rs::run_prepare`, and `upload_extension_with` through it. Use `--` before the host; reject option-like hosts, NUL/control characters, invalid POSIX environment names, oversized host/cwd/runtime/command/session/identity inputs, and unsafe executable/program values. Shell-quote every remote value and argument. Propagate validation errors through `start_agent`, catalog loading, prepare, and staging; only documented operational staging failure may use sentinel fallback. Test every caller, hostile quoting, bounds, controls, invalid env names, leading-dash hosts, and that invalid construction never spawns SSH.

6. **Make speech acknowledged, cancellable, and correlated.**  
   In `src/api.rs::{SpeechRequest,DeliveryState,speak,process_speech,synthesize_reply_if_current}`, use one canonical end-to-end speech deadline, 25 seconds, covering extension request, HTTP handler, TTS, queue admission, and acknowledgement. Carry cancellation and a oneshot result; dropping the request, timeout, worker shutdown, stale identity, stale connection, or failed TTS cancels the reservation. Update `src/audio.rs::{Speaker::synthesize,TtsTransport::send}` to honor the remaining deadline.

   `/speak` returns successful delivery only after TTS succeeds and the current connection writer accepts the frame. No browser returns HTTP 200 with `delivered:false`; the extension marks that result `isError:true`, preserving written fallback. TTS/queue/identity failures return bounded non-success responses. `extensions/agent-switchboard.ts` returns explicit `isError:false` only for acknowledged speech. `Turn::agent_spoke` is true only for a `speak` with matching `tool_execution_start` and `tool_execution_end`, same `toolCallId`, and `isError:false`; start-only, failed, timed-out, or mismatched events preserve written fallback.

7. **Make audio reservations and WebSocket epochs atomic.**  
   Replace `AudioQueue` with `DeliveryState` reservations containing generation, connection epoch, sequence, deadline, cancellation, and one terminal state. Allocate a monotonically increasing connection epoch and register the connection before snapshot generation. A per-connection writer task owns socket writes and shutdown; replacement/disconnect retires the old writer and cancels its reservations. Queue-full and broadcast lag policy is deterministic: retire/cancel the affected connection, finalize reservations, and do not replay ephemeral audio.

   Generation transition and reservation cancellation occur in one `C -> D` transaction. Final identity validation, reservation finalization, and writer queue insertion are atomic; duplicate finalization and late TTS results are ignored. Preserve exact `epoch -> status -> history -> diagram` snapshot order and exact existing JSON audio metadata followed by binary audio framing. Tests cover registration-before-snapshot, replacement, disconnect, writer shutdown, lag, queue full, cancellation during TTS, generation races, no late audio, no duplicate audio, and no wedged sequence ordering.

8. **Repair browser playback and clip lifecycle races.**  
   In `web/app.ts`, make `playFailed` tear down the owner before requeueing exactly once; suppress repeated resume clicks while `play()` is pending; distinguish setup/cleanup pauses from user pauses; reset terminal-seek state on reverse seeking; accept both `pause -> ended` and `ended -> pause`; ignore native-player control clicks; and finalize recorder `onstop` before permitting a new recording. Serialize model-picker requests. When the server drops a stale clip, send an ID-bearing error so the outbox removes it instead of retrying forever. Update `web/protocol.ts` types only additively. Add deferred-promise tests in `tests/test_app.mjs` for every race and rebuild `static/app.js`.

9. **Remove cached status authority and preserve compatibility.**  
   In `src/api.rs`, remove `status_snapshot`, cached `Value` parameters, and lifecycle mirrors. `current_status` and `publish_status` become fresh projections from `Coordinator` plus current catalog state; route callbacks are invalidation signals only. `/status`, `/healthz`, snapshots, leg-state responses, and page replies all query fresh state. In `src/models.rs::ModelCatalog::resolve`, unavailable catalogs accept provider-qualified `provider/model[:thinking]` after normalization and reject bare names; add regression tests matching `legacy/backend/models.py`.

   Preserve newline JSONL commands/events, `RETURN_SENTINEL`, sentinel fallback, browser JSON shapes, binary framing, reconnect ordering, accepted-clip idempotency, written transcript events, one-caller ephemeral behavior, and legacy tests. Update `docs/rust-typescript-migration-handoff.md`, `docs/concurrency-and-test-hazards.md`, `docs/observability-and-coverage-handoff.md`, and relevant `README.md` text for identity fields, fail-closed remote redial, lock order, speech fallback, and separate homelab deployment. Homelab edits remain out of scope.

## Deterministic test mapping

- `src/pbx.rs`: lifecycle ownership, operation registration, candidate callback rejection, local/fake zero-overlap redial, unverified SSH operator settlement, verified adapter adoption, no partial publication, idle/shutdown coordinator paths.
- `src/pi_client.rs`: JSONL identity fields, tool-call correlation, SSH validation and all builder callers, bounded diagnostics, process close behavior.
- `src/api.rs`: lock-order/nonblocking callbacks, fresh status, token rejection, stale commits, WebSocket epochs/writers, audio cancellation/order, queue-full, fallback semantics, clip stale errors.
- `src/audio.rs`: deadline propagation, cancellation, bounded TTS failure.
- `tests/test_extensions.mjs`: token payloads, explicit speech success, `delivered:false` as `isError`, non-2xx fallback, diagram/state behavior.
- `tests/test_app.mjs`/`tests/test_protocol.mjs`: playback races, recorder cleanup, picker serialization, reconnect/outbox/epoch and exact wire framing.
- Documentation tests/checks: public contract and homelab boundary assertions.

## Rejected alternatives

- Remote FD/flock, remote lock files, pathname checks, or “wait for SSH teardown” as same-session safety.
- Starting an SSH same-session candidate after local child termination without verified remote acknowledgement.
- Publishing candidate state before adoption or buffering candidate public effects.
- Passing generation/operation fields from nonexistent `ExtensionAPI` operation context.
- Treating callback identity as authentication; it is stale-work correlation only.
- Counting `tool_execution_start` as successful speech.
- `receiver_count()` or queue insertion as successful speech acknowledgement.
- Cached status `Value` publication, independent generation ownership, unbounded queues, durable audio/history, Redis, databases, or homelab deployment edits.

## Acceptance commands

```text
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm test
git diff --exit-code -- static
```

External validation is limited to live SSH/Pi shutdown acknowledgement behavior, real Pi extension event ordering/context, browser/device media timing, ElevenLabs/STT timing, credentials, and the separate homelab pinned-tag deployment PR.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The plan closes review_v8's critical remote-lock finding with a fail-closed current-SSH policy, and maps lifecycle ownership, operation identity, SSH validation, callback gating, lock order, WebSocket/audio epochs, status freshness, compatibility, documentation, and deterministic tests to exact files and symbols."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository and prior-artifact inspection",
      "result": "passed",
      "summary": "Inspected plan_v8, review_v8, prior reviews, relevant Rust/TypeScript/browser paths, migration contracts, and concurrency hazards."
    },
    {
      "command": "cargo fmt --all -- --check; cargo test --locked; cargo clippy --locked --all-targets -- -D warnings; python3 -m unittest discover -s legacy/tests; npm test; git diff --exit-code -- static",
      "result": "not-run",
      "summary": "Implementation and verification are outside this planning-only task."
    }
  ],
  "validationOutput": [
    "Remote FD/flock design is explicitly rejected as unimplementable over SSH.",
    "Current SSH same-session redial has a bounded remote_shutdown_unverified operator-settlement path with no candidate or session-file reuse.",
    "Every SSH construction caller uses one Result-returning validator.",
    "All lifecycle mutations cross Coordinator; callbacks/status paths do not wait on PBX locks.",
    "WebSocket registration, writer ownership, queue saturation, epoch transitions, audio framing, and cancellation are specified.",
    "Provider-qualified unavailable-catalog passthrough and exact speech fallback semantics have regression tests."
  ],
  "residualRisks": [
    "Live SSH/Pi adapter shutdown acknowledgement and real extension event ordering require host validation.",
    "Browser media/autoplay timing and external STT/TTS latency require hardware/service validation.",
    "Homelab pinned-tag deployment remains a separate review."
  ],
  "noStagedFiles": true,
  "diffSummary": "Planning-only artifact; no source files changed.",
  "reviewFindings": [
    "critical closed: src/pi_client.rs remote FD/flock scheme removed; current SSH same-session redial fails closed",
    "high closed: src/pi_client.rs, src/pbx.rs SSH construction centralized and validated for every caller",
    "high closed: src/pbx.rs/api.rs operation registration, callback gating, candidate isolation, and coordinator ownership specified",
    "high closed: src/api.rs WebSocket writer/epoch/reservation lifecycle and exact framing specified",
    "high closed: src/pi_client.rs/extensions/agent-switchboard.ts successful speech correlation and fallback specified",
    "high closed: src/api.rs fresh status projection, lock order, and catalog compatibility specified",
    "medium closed: web/app.ts playback, stale outbox, recorder, picker, and reconnect races assigned deterministic tests"
  ],
  "manualNotes": "No unresolved implementation ambiguity remains inside the repository scope."
}
```

[38;2;136;136;136m✻ Turn took 5m 15s (Total time 5m 14s · 1 turn)[0m