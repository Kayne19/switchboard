# plan_v6: implementation plan

**Scope:** read-only implementation plan. Preserve approved decisions: `CallLifecycle` as sole mutable lifecycle authority, one-caller ephemeral behavior, legacy RPC/sentinel compatibility, unavailable-catalog passthrough, diagnostics-only phase status, no durable queue/database, and no homelab edits.

## Ordered slices

### 1. Establish ownership and lifecycle identity

In `src/pbx.rs`, add `CallLifecycle` with `LifecyclePhase::{Operator, Active, Quiescing, Candidate}`. It owns route, project identity, persistent session ID, current leg token, lifecycle generation, model/thinking state, activity time, and lifecycle diagnostics.

Use one shared coordinator handle. `Switchboard` and API status readers reference that handle; neither keeps a mutable lifecycle mirror.

| Owner | State/resources | Allowed responsibilities | Explicit non-owner |
|---|---|---|---|
| `CallLifecycle` | Phase, route/project, session ID, leg token, generation, model/thinking, activity, transition diagnostics | Serialized transitions, identity checks, callback acceptance, status projection | Process handles, WebSockets, audio queues, catalogs |
| `CandidateLeg` and session manager | `PiSession`, stdin/stdout/stderr, process-tree guard, candidate token, teardown/reaping | Start, close stdin, terminate descendants, await reap, report process failure | Route adoption or lifecycle authority |
| `Switchboard` services | Immutable config, registry, persona, environment, model catalog service, extension staging cache, session/adapters | Resolve projects/models, stage extensions, construct sessions, invoke lifecycle transitions | Duplicated route/token/generation/status |
| API transport state | Active WebSocket registry, per-connection outbound queues, `AudioQueue`, task/abort registry, transcript and diagram delivery state | Browser delivery, socket epochs, speech reservations, cancellation and transport responses | Lifecycle transitions or process ownership |

`accept_activity`, `accept_leg_state`, `accept_speak`, and `accept_diagram` must require `Active` plus the exact current leg token. A callback from `Quiescing`, `Candidate`, operator, a missing leg, or an old token returns rejection and is never buffered or emitted.

Each `PiSession` callback captures its leg token and candidate identity. Late activity from a closed/quiesced leg therefore fails the coordinator check without mutating activity or diagnostics. This keeps gating in `CallLifecycle` without moving process/resource ownership into it.

### 2. Quiesce before redial or replacement

Update `Switchboard::{transfer,redial,start_agent,drop_agent,force_hangup}` and `CandidateLeg`:

1. Under the coordinator transition lock, mark the current leg `Quiescing` and advance lifecycle generation.
2. Cancel API work stamped with the old lifecycle generation.
3. Reject old-leg `/speak`, `/leg-state`, and `/diagram` callbacks.
4. Close stdin, terminate the complete process tree through `PiSession::close`, and await reaping.
5. Start the replacement as `Candidate`, with a fresh leg token and candidate process resources.
6. Do not expose candidate route/model/session state to status or callbacks.
7. Adopt only after startup and introductory prompt succeed, atomically publishing route, model, persistent session ID, leg token, generation, `Active` phase, and the route event.
8. On candidate failure, close only the candidate and settle to operator.

The old leg remains rejected through teardown. Candidate callbacks are never queued. A same-session redial must not reopen until the old process has been reaped.

### 3. Make remote lock creation race-safe

In `src/pi_client.rs::remote_argv`, change the return type from `Vec<String>` to `Result<Vec<String>, PiSessionError>`.

Validate before command construction:

- host and session identity are non-empty, contain no NUL, and are at most 4096 bytes each;
- `cwd`, binary, extension, prompt, arguments, and environment names/values contain no NUL and fit their existing bounded limits;
- `$HOME` is absolute and at most 1024 bytes;
- generated lock path and complete remote command are each at most 8192 bytes.

Derive the lock key as exactly 64 lowercase hexadecimal characters from `SHA-256(host bytes + one NUL byte + persistent session ID bytes)`. Distinct host/session pairs must not alias; identical pairs must reuse the same key.

The remote command must use a small Python `os.open`/`os.mkdir`/`fcntl.flock` helper, not `mkdir -p`, `test -L`, or path checks followed by ordinary opens:

- Begin from an open descriptor for `/`.
- Walk every component of `$HOME`, `.cache`, `switchboard`, and `locks` by descriptor-relative operations.
- For each component, use `mkdirat` semantics if absent, then reopen with `O_DIRECTORY|O_NOFOLLOW`.
- `fstat` every opened directory and require a directory owned by the effective user with mode exactly `0700`.
- Reject `.` and `..` components and any symlink or replacement race. `ELOOP`, wrong type, ownership, mode, or path failure exits with the lock refusal status.
- Open `<64-hex>.lock` relative to the verified `locks` descriptor with `O_RDWR|O_CREAT|O_NOFOLLOW`, mode `0600`.
- `fstat` the lock descriptor and require a regular file owned by the effective user with mode exactly `0600`; never chmod or adopt a mismatched file.
- Duplicate the descriptor to fd 9 with close-on-exec disabled and call nonblocking exclusive `flock` on that descriptor.
- Contention exits 75 and writes bounded marker `remote_session_lock_busy`; all lock setup/symlink/validation failures also refuse with exit 75 but use a distinct bounded marker such as `remote_session_lock_invalid`.
- On success, `exec` the requested runtime while fd 9 remains inherited.

`src/pbx.rs::start_agent` must propagate `remote_argv` errors with `?` rather than constructing an unsafe fallback. `PiSession::start` must poll the child during a bounded startup grace period. If SSH exits immediately with code 75, inspect stderr markers, return a typed lock-busy/lock-invalid `PiSessionError`, and do not return an adoptable session. An EOF during the introductory prompt must apply the same marker classification before candidate adoption.

Tests in `src/pi_client.rs` must cover each pre-existing symlink location independently: `$HOME` component, `.cache`, `switchboard`, `locks`, and `<key>.lock`. The fake SSH must prove the runtime was never invoked. Also test wrong owner/mode, identity non-aliasing, concurrent same-session serialization, oversized input, and immediate fake-SSH exit 75. `src/pbx.rs` must prove exit-75 startup settles the candidate to operator without unsafe route adoption.

### 4. Give WebSocket connections explicit epochs

Replace browser-facing use of `broadcast::Sender::receiver_count()` with an active connection registry in `src/api.rs::AppInner`.

At the start of `websocket`, allocate `ConnectionEpoch` from an atomic counter, register a bounded per-connection `mpsc::Sender<Event>` as the active connection, and only then send the snapshot. The registry stores the active epoch and sender. Replacing a connection atomically:

- marks only the previous epoch cancelled;
- cancels its audio reservations;
- closes or drains its outbound queue;
- installs the new epoch;
- prevents old cleanup from touching the new connection by requiring epoch equality during unregister.

`SpeechRequest` and every `AudioQueue` reservation carry both lifecycle generation and `socket_epoch`. `/speak` does not accept a browser-supplied epoch: it atomically snapshots the currently active connection and its epoch during admission. No active connection returns `delivered:false` without reserving work.

All browser events, especially audio, are delivered through the exact captured connection sender. `receiver_count()` is not a delivery decision. A reconnecting connection cannot receive old-epoch audio, and a late close callback from the replaced socket cannot cancel the replacement.

`send_snapshot` sends `epoch`, fresh status, history, and diagram in that order. `tests/test_app.mjs` and `src/api.rs` must cover reconnect during TTS, replaced-socket cleanup after new registration, and audio delivery to the captured connection only.

### 5. Serialize cancellation, deadlines, reservation finalization, and audio commit

In `src/api.rs`, make `DeliveryState` the single mutex-protected owner of:

- active connection and socket cancellation state;
- current lifecycle generation;
- `AudioQueue`;
- reservation cancellation/deadline state.

`AudioQueue::reserve` records sequence, generation, socket epoch, deadline, and `Pending` state. `cancel`, `cancel_generation`, `cancel_epoch`, timeout handling, worker shutdown, TTS failure, and disconnect all acquire the same `DeliveryState` lock.

`finish_audio` must perform its validity check and final slot mutation in that same serialized critical section. It must verify:

- reservation is still pending;
- lifecycle generation and socket epoch are current;
- cancellation has not won;
- current time is strictly before the deadline;
- the exact active connection still owns the captured socket epoch.

If valid, it changes the slot to ready, drains ordered slots, and synchronously `try_send`s the resulting events to the captured connection while the delivery state remains serialized. If any check fails, it changes the slot to cancelled and advances the ordered cursor. It must never return with a pending slot at `emit`.

Timeout-versus-commit ordering is explicit: whichever operation acquires `DeliveryState` first wins. A commit that acquires the lock before the deadline and sees `now < deadline` is emitted; a timeout or cancellation that acquires it first permanently cancels the slot. No later check may reverse that result.

`SpeechRequest` carries a cancellation signal, deadline, generation, socket epoch, sequence, and completion acknowledgement. `process_speech` uses `tokio::select!` around TTS and cancellation/deadline, then calls only the serialized finalizer. TTS failure cancels its slot exactly once. A failed or timed-out `/speak` does not create a second written fallback; normal written reply synthesis creates at most one separate reservation after the failed speech reservation is finalized.

`src/audio.rs::{Speaker::synthesize,HttpTtsTransport::send}` receive the remaining deadline. The HTTP request is dropped on cancellation and cannot commit after the deadline. The extension keeps a 27-second transport timeout as grace over the server’s canonical 25-second deadline.

Deterministic tests in `src/api.rs` must include:

- timeout wins while holding the delivery-state barrier;
- commit wins before deadline while holding the barrier;
- stale generation and stale socket epoch cancel without emission;
- worker drop finalizes a reservation;
- delayed TTS after cancellation produces no late audio;
- failed speech produces no duplicate written fallback audio;
- ordered later reservations are not wedged by a cancelled earlier slot.

### 6. Correlate completed speech tool calls

In `src/pi_client.rs::{Signal,Turn,collect}`, retain `toolCallId` from `tool_execution_start` and mark speech only after a matching `tool_execution_end` with `isError == false`. Start-only, failed, and mismatched completions do not count. `Turn::agent_spoke()` must reflect only successfully completed `speak` calls.

In `extensions/agent-switchboard.ts`:

- include `SESSION_TOKEN` in state, speech, and diagram request bodies;
- retain existing tool names, sentinel behavior, and response fields;
- treat non-2xx and `delivered:false` speech responses as `isError:true`, so written fallback remains available;
- preserve successful acknowledged speech as successful;
- retain existing non-error informational behavior for an unavailable browser where approved compatibility requires it, while ensuring the Rust endpoint’s explicit speech contract is authoritative.

Update `tests/test_extensions.mjs` for token propagation, non-2xx failure, `delivered:false`, successful acknowledgement, and diagram requests.

### 7. Remove stale status publication paths

In `src/api.rs`, remove `AppInner::status_snapshot`, `current_status`, and `publish_status`. Remove caller-supplied `Value` status arguments from `deliver_page_reply_if_current` and `deliver_turn_if_current` at the current `src/api.rs:916-965` call path. Operation futures return replies/results, not precomputed status values.

Define `emit_status_projection` as a status-emission helper that queries the shared `CallLifecycle` coordinator at emission time. It must not accept a status `Value`. It acquires the coordinator’s serialized read/projection path after the relevant lifecycle mutation and emits the resulting presentation JSON.

Use fresh projection for:

- `status` and `healthz`;
- `send_snapshot`;
- connect, thinking, model, hangup, leg-state, and diagram responses;
- route callbacks;
- turn and page-reply delivery;
- any status event emitted after a lifecycle transition.

`RouteCallback` should signal that a route event occurred without carrying a precomputed `Value`; the API then calls `emit_status_projection`. Lifecycle mutation and status emission must use the coordinator transition ordering so a newer mutation cannot be followed by an older cached projection.

Tests must mutate lifecycle state between a result becoming ready and status emission, then assert the emitted status contains the newer route/model/thinking state. No API helper may overwrite coordinator state from a caller-provided JSON value.

### 8. Preserve stale barriers and bounded diagnostics

Route awaited side effects through identity checks in:

- `src/pbx.rs::{handle,handle_agent,process_turns,deliver_turn_if_current}`;
- `src/api.rs::{process_clips,process_speech,deliver_page_reply_if_current,synthesize_reply_if_current}`.

Capture lifecycle generation when accepting clips, queued turns, and speech. Capture socket epoch when accepting browser delivery. Reject both identities at every commit boundary.

Retain the 256-entry in-memory diagnostics ring with process-global monotonic sequence numbers, UTF-8-safe 128-byte fields, and serialized payloads capped at 2 KiB. Exclude tokens, prompts, transcripts, stderr, paths, secrets, and raw tool arguments.

## Slice-local tests

- `src/pbx.rs`: lifecycle ownership, transition serialization, quiescing rejection for all internal callbacks, late activity rejection, candidate no-buffering, close-before-reopen, status freshness, exit-75 operator settlement, and diagnostic bounds.
- `src/pi_client.rs`: lock-key derivation, identity non-aliasing, all ancestor/file symlink cases, ownership/mode rejection, path bounds, same-session serialization, immediate exit-75 classification, and tool-result correlation.
- `src/api.rs`: connection epoch allocation/replacement, old-socket cleanup safety, reconnect during TTS, exact-connection delivery, atomic timeout/commit races, cancellation finalization, no duplicate fallback, stale generation/epoch rejection, and fresh status projection.
- `src/audio.rs`: remaining-deadline propagation, delayed transport cancellation, and bounded TTS timeout.
- `tests/test_extensions.mjs`: callback tokens, speech failure semantics, successful acknowledgement, and diagram token propagation.
- `tests/test_protocol.mjs`, `tests/test_app.mjs`, and legacy tests: epoch wire behavior, reconnect handling, audio ordering, sentinel/RPC compatibility, and unavailable-catalog passthrough.

## Rejected alternatives

- `mkdir -p`, `test -L`, or check-then-open lock creation: vulnerable to symlink substitution races.
- Plain or truncated lock keys: distinct host/session identities can alias.
- Reusing an existing lock file without `O_NOFOLLOW`, `fstat`, owner, and exact-mode checks: permits unsafe adoption.
- Keeping `remote_argv -> Vec<String>`: local lock validation errors cannot propagate safely.
- Treating every SSH exit 75 as successful startup: permits unsafe candidate adoption.
- Generation checks outside the audio mutex: a worker can pass the check before cancellation and emit late.
- Leaving cancelled reservations pending: wedges ordered audio behind an unreachable slot.
- `broadcast::Sender::receiver_count()` as delivery identity: it cannot identify the browser that should receive audio.
- Disconnect cleanup that unconditionally cancels the current connection: an old socket can cancel a replacement.
- Caller-supplied status `Value` arguments: cached status can overwrite a newer lifecycle projection.
- Putting process resources, catalogs, staging, queues, or WebSockets inside `CallLifecycle`: creates a lifecycle god object.
- Durable diagnostics, Postgres, Redis, run queues, history cloning, rollback, or homelab edits.

## Exact file/symbol mapping

- `src/pbx.rs`: `CallLifecycle`, `LifecyclePhase`, `CandidateLeg`, `Switchboard`, `transfer`, `redial`, `start_agent`, `drop_agent`, `force_hangup`, `agent_env`, `report_leg_state`, `status`, `RouteCallback`, activity callback construction.
- `src/pi_client.rs`: `remote_argv`, lock helper command construction, `PiSession::start`, `PiSession::close`, startup exit classification, `Signal`, `Turn::agent_spoke`, `collect`.
- `src/api.rs`: `AppInner`, `DeliveryState`, `ConnectionEpoch`, `SpeechRequest`, `AudioQueue`, `reserve_audio`, `finish_audio`, `process_speech`, `speak`, `leg_state`, `diagram`, `websocket`, `send_snapshot`, `emit_status_projection`, `deliver_page_reply_if_current`, `deliver_turn_if_current`, `synthesize_reply_if_current`.
- `src/audio.rs`: `Speaker::synthesize`, `HttpTtsTransport::send`, deadline/cancellation tests.
- `extensions/agent-switchboard.ts`: `SESSION_TOKEN`, speech timeout and failure handling, state/diagram request bodies.
- `tests/test_extensions.mjs`, `tests/test_protocol.mjs`, `tests/test_app.mjs`: browser and extension contract tests.
- `Cargo.toml`, `Cargo.lock`: `sha2` dependency if not already present.
- No homelab files.

## Acceptance commands

```text
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm test
git diff --exit-code -- static
```

No source files are edited by this plan. The five review blockers have specified mechanisms, ownership, propagation, and deterministic tests with no unresolved implementation ambiguity.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete review findings are addressed with exact file/symbol mappings, severity, mechanisms, propagation paths, ownership boundaries, deterministic tests, and acceptance commands."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection and plan revision",
      "result": "not-run",
      "summary": "Planning only; no source files were edited."
    }
  ],
  "validationOutput": [
    "Verified current remote_argv, start_agent, PiSession startup, AudioQueue/finish_audio, WebSocket delivery, SpeechRequest, status helpers, lifecycle mirrors, and extension callback paths."
  ],
  "residualRisks": [
    "Live SSH hosts, TTS service behavior, browser scheduling, and homelab deployment remain external validation surfaces."
  ],
  "noStagedFiles": true,
  "diffSummary": "No source changes; plan_v6 replaces the underspecified plan_v5.",
  "reviewFindings": [
    "closed high: src/pi_client.rs:795 and src/pbx.rs:738 - remote_argv now has Result propagation, descriptor-relative O_NOFOLLOW creation, strict owner/mode checks, bounded paths, symlink tests, and immediate exit-75 classification.",
    "closed high: src/api.rs:353-390 - cancellation/deadline and final audio commit share one serialized DeliveryState operation with explicit timeout-versus-commit ordering and reservation finalization tests.",
    "closed high: src/api.rs:863-895 and websocket - each connection receives an epoch, SpeechRequest/audio reservations capture it, replacement/disconnect cancels only the old epoch, and delivery targets the exact connection rather than receiver_count.",
    "closed medium: src/api.rs:916-965 - caller-supplied status Values are removed; emit_status_projection queries CallLifecycle at emission time and stale-projection tests are required.",
    "closed medium: lifecycle ownership - the explicit table separates CallLifecycle transitions, CandidateLeg/session resources, Switchboard configuration/catalog/staging/adapters, and API transport state; late quiesced-leg callbacks are rejected by token and phase."
  ],
  "manualNotes": "No source files were edited. No unresolved ambiguity remains for the review_v5 blockers."
}
```

[38;2;136;136;136m✻ Turn took 4m 29s (Total time 4m 28s · 1 turn)[0m