# Final implementation plan

**Scope:** read-only plan. Preserve one-caller ephemerality, in-memory state, existing wire shapes, legacy compatibility, and the homelab boundary.

## Ordered implementation slices

### 1. Establish sole lifecycle ownership

- Add `CallLifecycle` in `src/pbx.rs`.
- It exclusively owns route, project, model spec, persistent `session_id`, authoritative/candidate `PiSession`s, `leg_token`, generation, phase, operation identity, terminal outcome, operator note, activity, and the bounded diagnostic trace.
- `Switchboard` retains immutable configuration and adapter dependencies: registry, model catalog/cache, process-launch configuration, audio/callback dependencies, extensions, environment, and staging cache.
- Remove lifecycle duplicates from `Switchboard`: `route`, `project`, `operator`, `agent`, `active_session`, `model_spec`, `session_id`, `live_leg`, `operator_note`, and lifecycle activity/generation state. Do not replace them with mirrored fields.
- `Switchboard::{status,route,touch_activity,handle,dial,set_model,set_thinking,force_hangup,shutdown}` becomes a facade delegating to lifecycle commands.
- `AppState` removes `active_session`, `live_leg`, `turn_generation`, `operation_transition`, and status-as-lifecycle state. It retains transport concerns such as STT/TTS queues, transcript storage, WebSocket events, and active task handles.

Coordinator commands are `Connect`, `Transfer`, `Redial`, `ReturnToOperator`, `Hangup`, `Rescue`, `SetModel`, `SetThinking`, `StartTurn`, `AcceptCallback`, `IdleDrop`, and `Shutdown`. Queries are `snapshot`, `route`, `phase`, `current_leg`, `validate_callback`, `turn_identity`, and `last_activity`.

All mutations cross one synchronous `linearize()` boundary. Awaited process/audio work reserves an identity before suspension and commits through `linearize(expected_identity, ...)` afterward. No broadcaster or external callback is awaited inside that boundary.

**Tests:** coordinator unit tests prove serialized commands, monotonic event sequence, no API lifecycle mutation, and no broadcaster await while lifecycle state is held.

### 2. Make candidate adoption transactional

- Refactor `src/pbx.rs::{transfer,start_agent,redial,drop_agent,force_hangup}` around `CandidateLeg`.
- A candidate owns its process, session ID, fresh `leg_token`, and startup/intro results without changing visible route/project/model state.
- Adoption atomically commits route, project, model, session ID, leg token, generation, phase, and lifecycle event.
- Only after adoption does the old authoritative process close for new-session transfer/redial.
- Candidate intro callbacks are never current. `/speak`, `/diagram`, `/leg-state`, and callback-form `/thinking` are rejected with bounded machine-readable failure, never buffered, and cannot write transcript, diagram, status, audio, or “agent spoke” state.
- Candidate intro text is staged as written/transcript-only. If adoption succeeds it may be committed as transcript; it is not retroactively synthesized. If adoption fails, it is discarded or diagnostic-only.
- Rescue or cancellation closes only the candidate and preserves the old leg when one remains authoritative; otherwise it settles to `OperatorReady`.

**Tests in `src/pbx.rs` and `src/api.rs`:** rescue during prepare, startup, and intro; candidate callback rejection for every endpoint; no candidate speech suppresses fallback; no project-looking terminal state without an adopted process.

### 3. Define same-session redial safety

For `redial(keep_context=true)`:

1. Linearize `Redialing`, invalidate the old leg token/generation, and make the old process non-current.
2. Fully close and reap the authoritative old `PiSession` before calling `PiSession::start` with the reused persistent `session_id`.
3. Start the candidate with a new per-process `leg_token`.
4. Adopt only after startup and intro succeed.
5. If reopening or intro fails, do not reopen the old session concurrently or attempt unsafe rollback. Settle to the operator and clear project-leg state.

This deliberately gives up simultaneous preservation during same-session redial. Context remains in the persistent Pi session file, but the old process is not kept alive while that file is reopened.

For `keep_context=false`, and for new-session transfer/redial, use the normal candidate path: a fresh session ID may run beside the authoritative old leg until adoption. Candidate adoption remains transactional.

`src/pi_client.rs::PiSession::close` must be idempotent and complete: close stdin, terminate the process tree, await child reaping, and finish process cleanup before returning.

**Deterministic test:** add a `src/pbx.rs` test using `write_executable_script` from `src/pi_client.rs`. The fake Pi process acquires a session-file lock/marker, records start and close events, and the candidate fails to reopen. Assert the maximum concurrent process count for the reused session is one, candidate start occurs after old close, no candidate callback is accepted, final phase/route is operator, and the persistent session file is never touched concurrently.

### 4. Separate callback correlation from internal turn identity

Use only a per-process external `leg_token`:

- `src/pbx.rs::agent_env` passes the token in `SWITCHBOARD_SESSION_TOKEN`.
- `extensions/agent-switchboard.ts` sends `token: SESSION_TOKEN` in the request body for state/thinking, speak, and diagram callbacks.
- `SWITCHBOARD_SPEAK_URL`, `SWITCHBOARD_DIAGRAM_URL`, and `SWITCHBOARD_STATE_URL` therefore carry the process token through their callback request bodies.
- `src/api.rs` validates the token at callback ingress through `CallLifecycle::validate_callback`.
- Invalid, missing, candidate, or late tokens return bounded `409` JSON such as `accepted:false, code:"invalid_leg"` without exposing the token.

When a callback is accepted, the coordinator attaches the current internal `operation_id` and `generation` to the accepted leg-scoped callback. Those values are never promised through static process environment.

Do not add fake per-operation callback fields to `PiSession::prompt`, `steer`, or JSONL. Existing RPC remains message-only (`type` plus `message`) because it has no safe per-turn ExtensionAPI metadata path. Callback correlation is not authentication; deployment authentication remains a separate concern. Late callbacks from an invalidated leg are rejected.

The existing page-control `POST /thinking` remains a browser command. Any agent callback variant exposed under that route must use the same validator as `/leg-state`; do not confuse page commands with callback identity.

**Tests:** `tests/test_extensions.mjs` checks token request bodies; `src/api.rs` tests missing, stale, candidate, and current tokens; `src/pi_client.rs` tests confirm no fabricated operation/generation JSONL fields.

### 5. Add stale-result barriers and adapter outcomes

- Refactor `src/pbx.rs::{handle,handle_agent,process_turns,deliver_turn_if_current}` and `src/api.rs::{deliver_page_reply_if_current,synthesize_reply_if_current}` to use coordinator identity validation immediately before every awaited side-effect commit.
- Cover prompt, steer, STT, TTS, transcript, audio, diagram, callback, process close, and terminal outcome.
- Stamp browser recording epochs at recording start, retaining the existing rescue behavior.
- Extend `src/pi_client.rs::{Turn,Signal,collect}` to distinguish tool started/completed/failed while preserving JSONL and sentinel compatibility.
- Mark speech as successful only after an accepted successful callback outcome. HTTP failure, stale-leg rejection, incomplete speech, and TTS failure must leave normal reply synthesis enabled.

**Slice-local tests:** stale prompt, callback, audio, diagram, transcript, rescue during STT/turn/transfer/redial, reused session ID with a new token, and failed `speak` still synthesizing the reply.

### 6. Preserve model and public status contracts

- In `src/pbx.rs::resolve_model` and `src/models.rs::ModelCatalog::resolve`, when catalogs are unavailable accept only provider-qualified `provider/model[:thinking]`, preserving the supplied provider/model and normalized thinking. Keep unqualified names rejected.
- Add unavailable-catalog passthrough tests and retain catalog-present validation tests.
- Keep lifecycle events diagnostics-only: an in-memory ring of 256 entries, process-lifetime monotonic sequence, no persistence, no replay endpoint, and diagnostic drops that do not affect calls.
- Add only sanitized additive `phase` and optional diagnostic sequence to existing status. Cap strings at 128 bytes and serialized diagnostics at 2 KiB; exclude raw tokens, prompts, transcripts, stderr, paths, and secrets.
- Preserve reconnect ordering: `epoch → status → history → diagram`.

### 7. Documentation and acceptance boundary

Update `README.md`, `docs/concurrency-and-test-hazards.md`, `docs/observability-and-coverage-handoff.md`, and `docs/rust-typescript-migration-handoff.md` with:

- `CallLifecycle` ownership and command/query boundary.
- Per-process `leg_token` versus persistent `session_id`.
- Same-session redial quiesce tradeoff and operator fallback.
- Callback correlation versus authentication.
- Ephemeral one-caller semantics.
- Existing `SWITCHBOARD_*` environment contracts and logging variables.
- No Postgres, Redis, run queue, durable lifecycle journal, or homelab edits.
- Legacy Python compatibility and separate homelab pinned-tag/cutover work.

## Rejected alternatives

- Concurrent same-session processes: unsafe against one persistent Pi session file.
- History cloning: Pi session-file semantics are not safely cloneable here.
- Same-session rollback: reopening the old process risks concurrent file access; operator fallback is safer.
- Per-operation metadata in static environment or fabricated Pi JSONL fields: cannot provide real per-turn identity.
- API lifecycle mirrors, public lifecycle replay, Postgres, Redis, run queues, browser state machinery, and premature legacy deletion.

## Exact file/symbol mapping

- `src/pbx.rs`: `CallLifecycle`, `CandidateLeg`, identity validation, adoption, redial/transfer, facade delegation, status projection, model fallback, lifecycle tests.
- `src/api.rs`: coordinator handle, callback request structs/ingress, removal of lifecycle mirrors, stale delivery barriers, endpoint tests.
- `src/pi_client.rs`: complete `PiSession::close`, typed tool outcomes, unchanged message-only RPC, deterministic executable helper/tests.
- `extensions/agent-switchboard.ts`: token fields on callback bodies and bounded failure handling.
- `src/models.rs`: provider-qualified unavailable-catalog behavior and tests.
- `tests/test_extensions.mjs`, `tests/test_protocol.mjs`, existing Rust tests, and legacy tests: compatibility and callback coverage.
- `README.md` and the three concurrency/observability/migration docs: contracts and cutover notes.

## Acceptance commands

```text
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm test
git diff --exit-code -- static
```

No implementation-scope decisions remain unresolved. Host SSH/STT/TTS behavior, credentials, hardware validation, and homelab pinned-tag deployment remain external validation risks, not changes to this repository.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Final read-only plan resolves same-session redial quiescing, exact callback token transport, sole CallLifecycle ownership, candidate callback rejection, transactional adoption, compatibility requirements, tests, file mapping, and acceptance commands."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection and final plan revision",
      "result": "not-run",
      "summary": "Planning only; no source files edited."
    }
  ],
  "validationOutput": [
    "Mapped each blocker to concrete symbols, mechanisms, deterministic tests, and documented tradeoffs.",
    "Preserved unavailable-catalog passthrough, failed-speak fallback, bounded diagnostics, status ordering, ephemerality, legacy compatibility, and homelab separation."
  ],
  "residualRisks": [
    "Callback correlation is not authentication.",
    "Live SSH, STT, TTS, credentials, hardware, and homelab cutover still require host validation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; final implementation plan only.",
  "reviewFindings": [
    "critical: src/pbx.rs redial keep_context=true previously allowed same-session process overlap.",
    "high: extensions/agent-switchboard.ts and src/pi_client.rs lacked a real per-process callback identity mechanism.",
    "high: src/pbx.rs and src/api.rs left lifecycle ownership split and duplicated.",
    "high: src/api.rs allowed candidate callback side effects before adoption."
  ],
  "manualNotes": "The authoritative artifact is this plan; runtime persistence will write it to the configured plan_v3.md output path."
}
```

[38;2;136;136;136m✻ Turn took 3m 22s (Total time 3m 22s · 1 turn)[0m