# plan_v5: implementation plan

**Scope:** read-only implementation plan. Preserve `CallLifecycle` as the sole mutable lifecycle owner, one-caller ephemerality, legacy RPC/sentinel compatibility, unavailable-catalog passthrough, diagnostics-only phase status, no Postgres/Redis/run queue, and no homelab edits.

## Ordered slices

1. **Centralize lifecycle and callback gating.**  
   In `src/pbx.rs`, introduce `CallLifecycle` with `LifecyclePhase::{Operator, Active, Quiescing, Candidate}`. Move route, project, persistent `session_id`, per-process `leg_token`, generation, model, thinking, activity clock, and diagnostics into it. `Switchboard` becomes an async facade with configuration and coordinator access only; remove duplicate `active_session`, route, token, generation, `LiveLegState`, and `ActivityClock` ownership.

   Add coordinator commands for status snapshots, activity, callback acceptance, candidate adoption, quiescing, and terminal settlement. `accept_callback` succeeds only in `Active` with the exact current per-process token. `Quiescing`, `Candidate`, operator, missing, and stale tokens are rejected with bounded `409` responses and never buffered.

2. **Make same-session redial quiescent before reopening.**  
   Update `Switchboard::{transfer,redial,start_agent,drop_agent,force_hangup}` and `CandidateLeg` so redial first marks the old leg `Quiescing`, advances internal generation, rejects `/speak`, `/leg-state`, and `/diagram`, closes stdin, terminates the entire old process tree, and awaits reaping. Only then may a same-session candidate start.

   Candidate state remains invisible and callback-rejecting until atomic adoption of route, model, persistent session ID, new leg token, generation, phase, and route event. Candidate failure closes only the candidate and settles to operator. Candidate callbacks are never queued.

3. **Make remote locking collision-safe and bounded.**  
   In `src/pi_client.rs::remote_argv`, add `sha2` and derive exactly 64 lowercase hex characters from `SHA-256(host bytes + NUL + persistent session_id bytes)`. Reject empty, NUL-containing, or oversized host/session identities before building the command; cap each at 4096 bytes and reject any generated command or lock path exceeding 8192 bytes.

   Use the fixed remote directory `$HOME/.cache/switchboard/locks`. The remote shell must require an absolute `$HOME` of at most 1024 bytes, `flock` availability, a lock directory created with `umask 077`, mode `0700`, current-user ownership, and a non-symlink directory. Create/open only `<64-hex>.lock` with mode `0600`, then acquire it using nonblocking `flock` on inherited FD 9 before `exec pi`. Any directory, validation, lock-file, or `flock` failure exits 75; contention emits bounded `remote_session_lock_busy` diagnostics.

   `PiSession::close` must finish local tree termination and reaping before same-session candidate startup. Exit 75 or the marker maps to bounded `remote_session_lock_busy`; candidate resources are reaped and lifecycle settles to operator. Distinct host/session pairs must never share a key; same pairs must share one key.

4. **Define one bounded speech deadline with cancellation.**  
   In `src/api.rs::{SpeechRequest,speak,process_speech}`, use one canonical 25-second speech deadline from request admission through TTS and audio commit. `extensions/agent-switchboard.ts` uses a 27-second fetch timeout only as transport grace; it does not extend server work. The server refuses all commits at the 25-second cutoff.

   Carry a cancellation signal and acknowledgement oneshot in `SpeechRequest`. Dropping the HTTP handler, deadline expiry, worker shutdown, TTS failure, stale generation, stale socket epoch, or lost browser cancels the request and reserved audio slot. `src/audio.rs::{Speaker::synthesize,HttpTtsTransport::send}` must receive the remaining deadline; dropping the future cancels the HTTP request. No worker may commit after cancellation or deadline.

   `/speak` validates the real token before logging or queueing. It returns success only after TTS succeeds, the generation and socket epoch still match, a browser remains connected, and `finish_audio` emits the committed frame. Return `200 delivered:false` only for no browser; return bounded `409` for callback identity failure, `502` for TTS failure, `503` for worker failure, and `504` for timeout. Failed speech never suppresses written-reply fallback.

5. **Prevent stale audio reservations from wedging ordering.**  
   Extend `AudioQueue::{reserve,finish,clear}` with socket epoch and explicit slot state. Add `AudioQueue::cancel(sequence, generation, socket_epoch)` and `cancel_epoch(epoch)`. Every stale-generation, stale-epoch, disconnected, timeout, worker-drop, and TTS-error path must cancel or finalize the slot; `finish_audio` must never return while leaving a pending slot at `emit`.

   `src/api.rs::websocket` cancels the disconnected socket epoch before returning. `synthesize_reply_if_current` cancels its reservation on every stale barrier. A committed slot resolves its acknowledgement only when ordering drains and the browser event is emitted. Reconnect ordering remains `epoch → status → history → diagram`.

6. **Correlate speech tool completion, not tool start.**  
   In `src/pi_client.rs::{Signal,Turn,collect}`, track `toolCallId` from `tool_execution_start` and only mark `speak` successful after a matching `tool_execution_end` with `isError` false. Start-only, failed-end, and mismatched-ID events do not count as speech. `Turn::agent_spoke()` is true only for successful completed `speak`.

   In `extensions/agent-switchboard.ts`, include `SESSION_TOKEN` in state, speak, and diagram bodies. Non-2xx and `delivered:false` speech responses return `isError:true`; successful acknowledged delivery remains successful. Preserve existing tool names, sentinel behavior, and response fields.

7. **Remove API lifecycle/status mirrors.**  
   In `src/api.rs::AppInner`, delete `status_snapshot`, `active_session`, `activity_clock`, `live_leg`, `operation_transition`, and authoritative generation mirrors once coordinator commands replace them. Delete `current_status` and `publish_status`; replace them with stateless `coordinator_status`/`emit_status_projection` helpers that query `CallLifecycle` and immediately emit presentation JSON.

   `status`, `healthz`, `send_snapshot`, turn dispatch, page controls, and callback responses must obtain fresh projections from the coordinator. `status` JSON remains presentation-only; any phase field is diagnostics-only and cannot mutate lifecycle. Add tests proving a lifecycle mutation is visible through fresh status queries and stale projections cannot overwrite current state.

8. **Retain stale barriers and bounded diagnostics.**  
   Route awaited commits through coordinator identity checks in `src/pbx.rs::{handle,handle_agent,process_turns,deliver_turn_if_current}` and `src/api.rs::{process_clips,process_speech,deliver_page_reply_if_current,synthesize_reply_if_current}`. Keep capture-generation stamping, provider-qualified unavailable-catalog passthrough, one-caller ephemeral audio/activity state, and legacy compatibility.

   Keep the 256-entry in-memory trace ring with process-global monotonic sequence, UTF-8-safe 128-byte field caps, and serialized payloads capped at 2 KiB. Exclude tokens, prompts, transcripts, stderr, paths, secrets, and raw tool arguments.

## Slice-local tests

- `src/pbx.rs`: lifecycle coordinator ownership, serialized commands, `Quiescing` rejection for `/speak`, `/leg-state`, and `/diagram`, candidate rejection/no buffering, same-session close-before-reopen, lock-busy operator settlement, status refresh, and trace bounds.
- `src/pi_client.rs`: fixed 64-hex lock keys, distinct identity non-aliasing, oversized identity rejection, secure lock command/modes/path bounds, same-session fake SSH serialization, and tool-result correlation.
- `src/api.rs`: acknowledged speech, timeout cancellation, worker-drop cancellation, no duplicate speech, stale generation/epoch rejection, reconnect/disconnect during TTS, reservation cancellation/unwedged ordering, token rejection, and status ownership.
- `src/audio.rs`: deadline propagation, cancellation of delayed transport, and bounded TTS timeout.
- `tests/test_extensions.mjs`: token in all callback bodies; non-2xx and `delivered:false` speech failures; successful acknowledgement; diagram callback behavior.
- `tests/test_protocol.mjs` and legacy tests: additive wire compatibility, epoch handling, sentinel/RPC behavior, and unchanged unavailable-catalog passthrough.

## Rejected alternatives

- Truncated or plain hex lock names: distinct identities can alias.
- Per-process lock files, blocking `flock`, or waiting for remote SSH teardown: unsafe or nondeterministic.
- Independent 30-second client/server deadlines or late worker commits: can trigger fallback before original audio.
- Returning from stale `finish_audio` without cancelling its slot: wedges later ordered audio.
- Relying only on token mismatch after adoption: leaves a redial teardown acceptance window.
- Retaining `status_snapshot` as mutable authority: duplicates lifecycle state.
- Durable diagnostics, browser lifecycle state, Postgres, Redis, run queues, history cloning, rollback, or homelab changes.

## Exact file/symbol mapping

- `src/pbx.rs`: `CallLifecycle`, `LifecyclePhase`, `CandidateLeg`, `Switchboard`, `transfer`, `redial`, `start_agent`, `drop_agent`, `force_hangup`, `agent_env`, `report_leg_state`, `status`, `ActivityClock`, diagnostics ring.
- `src/api.rs`: `AppInner`, `SpeechRequest`, `AudioQueue`, `reserve_audio`, `finish_audio`, `process_speech`, `speak`, `leg_state`, `diagram`, `websocket`, `send_snapshot`, stale delivery helpers.
- `src/audio.rs`: `Speaker::synthesize`, `HttpTtsTransport::send`, TTS deadline tests.
- `src/pi_client.rs`: `remote_argv`, `PiSession::close`, `Signal`, `Turn::agent_spoke`, `collect`.
- `extensions/agent-switchboard.ts`: callback tokens, deadline, failure semantics.
- `Cargo.toml`, `Cargo.lock`: `sha2` dependency.
- `tests/test_extensions.mjs`, `tests/test_protocol.mjs`, legacy tests.
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

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Plan v5 specifies exact collision-safe remote lock derivation, secure lock directory and failure behavior, one canonical speech deadline with cancellation and late-result suppression, explicit AudioQueue cancellation, Quiescing callback gates for every required callback, and removal of mutable API status ownership."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [
    "src/pbx.rs",
    "src/api.rs",
    "src/audio.rs",
    "src/pi_client.rs",
    "extensions/agent-switchboard.ts",
    "tests/test_extensions.mjs",
    "tests/test_protocol.mjs",
    "Cargo.toml",
    "Cargo.lock"
  ],
  "commandsRun": [
    {
      "command": "Repository inspection and plan revision",
      "result": "not-run",
      "summary": "Planning only; no source files edited."
    }
  ],
  "validationOutput": [
    "Reviewed current remote_argv, SpeechRequest/process_speech, AudioQueue/finish_audio, callback endpoints, extension payloads, and status mirror symbols.",
    "All five review_v4 blockers have explicit mechanisms, symbols, failure behavior, and slice-local tests."
  ],
  "residualRisks": [
    "Remote deployments must provide a trustworthy user-owned HOME and flock implementation.",
    "Live TTS, SSH, browser, credentials, and homelab cutover remain external validation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No source changes; revised implementation plan only.",
  "reviewFindings": [
    "closed high: src/pi_client.rs::remote_argv - SHA-256 fixed-length identity key, bounded inputs, secure lock directory, and exit-75 behavior are specified.",
    "closed high: extensions/agent-switchboard.ts and src/api.rs::process_speech - canonical deadline, cancellation propagation, worker-drop handling, and no-late-commit behavior are specified.",
    "closed medium: src/api.rs::AudioQueue and finish_audio - stale reservations are explicitly cancelled and tested during reconnect/disconnect.",
    "closed medium: src/pbx.rs lifecycle callbacks - Quiescing rejects old-leg speak, leg-state, and diagram callbacks.",
    "closed medium: src/api.rs status_snapshot/current_status/publish_status - mutable mirror is removed and replaced by fresh coordinator projections."
  ],
  "manualNotes": "No unresolved ambiguity remains for the five review_v4 blockers. No source files were edited."
}
```

[38;2;136;136;136m✻ Turn took 4m 7s (Total time 4m 6s · 1 turn)[0m