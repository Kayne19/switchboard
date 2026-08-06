# Handoff Output: plan_v2
Status: success
Verdict: (none)
Timestamp: 1786003610

## Content
# Revised Switchboard lifecycle migration plan

**Scope:** read-only plan; no source edits. Preserve one-caller ephemerality, in-memory state, existing wire shapes, and the legacy compatibility baseline.

## Target boundary

1. Add `CallLifecycle` beside `Switchboard` in `src/pbx.rs`. Its single `linearize()` boundary owns route, project, model, persistent Pi `session_id`, per-process `leg_token`, generation, phase, operation, and terminal outcome.
2. Expose typed commands (`Connect`, `Transfer`, `Redial`, `ReturnToOperator`, `Hangup`, `Rescue`, `SetModel`, `StartTurn`, `Shutdown`, `AgentCallback`) and queries (`snapshot`, `validate_identity`, `active_leg`). `src/api.rs` submits commands and reads snapshots; it no longer owns `turn_generation`, `operation_transition`, `active_session`, route state, or lifecycle cancellation state.
3. Keep queues, task handles, audio sequencing, and HTTP/WebSocket validation in `src/api.rs`. Never await event broadcasters while holding coordinator state.
4. Define `OperationIdentity { operation_id, generation, leg_token }`. `leg_token` is freshly generated for every Pi process, independent of persistent `session_id`, which redial may reuse.
5. Every `PiSession` prompt/steer/close and every `/speak`, `/diagram`, `/leg-state`, and `/thinking` callback carries and validates the full identity. Recheck identity immediately before every awaited side-effect commit: route/session/status, transcript/history, reply, audio, diagram, and terminal outcome.

## Ordered slices

### 1. Coordinator seam and atomic events

- Refactor `src/api.rs` symbols `status_snapshot`, `current_status`, `publish_status`, `operation_transition`, `turn_generation`, and `active_session` behind coordinator commands/queries.
- Add typed `LifecycleEvent { seq, identity, phase, outcome, sanitized_payload }`; allocate sequence and mutate coordinator state atomically in `linearize()`.
- Phases: `OperatorReady`, `ProjectPreparing`, `ProjectStarting`, `ProjectIntro`, `ProjectActive`, `TurnRunning`, `Returning`, `Redialing`, `Rescuing`, `Shutdown`.
- Acceptance: coordinator tests prove serialized commands, one monotonic event sequence, no API lifecycle mutation, and no broadcaster await under the state guard.

### 2. Candidate-leg adoption and rescue rollback

- Refactor `src/pbx.rs::{transfer,start_agent,redial,drop_agent,force_hangup}`.
- A provisional candidate owns its process, `session_id`, and new `leg_token` until startup and intro both succeed. The prior leg remains authoritative meanwhile.
- Adoption commits only after successful intro: route, model, project, session, token, generation, phase, and event change in one linearization step; old-leg closure happens afterward with identity-bound ownership.
- Startup/intro cancellation or failure closes only the candidate, preserves the prior leg when valid, and otherwise returns to `OperatorReady`; rescue during setup follows the same rollback.
- Acceptance: deterministic races cover rescue during prepare, startup, and intro; assert candidate closure, prior-leg preservation, operator fallback, and no project-looking state without an adopted process.

### 3. Identity propagation and stale-result barriers

- Add token/operation fields to the extension callback bodies in `extensions/agent-switchboard.ts`; pass per-operation identity through the Pi control/protocol path in `src/pi_client.rs`.
- Update `src/pbx.rs::{handle,handle_agent,process_turns,deliver_turn_if_current}` and `src/api.rs::{deliver_page_reply_if_current,synthesize_reply_if_current}` to use `validate_identity`.
- Validate immediately before and after every awaited prompt, steer, STT, TTS, process close, callback, and commit. Retain browser epoch stamping at recording start.
- Acceptance: race tests in this slice cover stale prompt, stale callback, stale audio, stale diagram, stale transcript, rescue during STT/turn/transfer/redial, and reused persistent session IDs with different leg tokens.

### 4. Model and adapter compatibility

- In `src/models.rs::ModelCatalog::resolve`, retain provider-qualified passthrough when the catalog is unavailable: `provider/model[:thinking]` is accepted and preserved; unqualified names remain rejected because no provider can be selected.
- Extend `src/pi_client.rs::{Turn,Signal,collect}` to distinguish tool started/completed/failed and preserve JSONL/sentinel compatibility.
- Fix failed `speak` fallback in `src/pbx.rs` so only confirmed successful speech suppresses synthesis; failed or incomplete speech permits normal reply synthesis.
- Acceptance: unavailable-catalog provider passthrough tests, terminal tool-outcome tests, and a regression proving failed `speak` still synthesizes the reply.

### 5. Diagnostics and status projection

- Keep lifecycle events diagnostics-only internal typed events. Do not add a public lifecycle replay WebSocket protocol.
- Use an in-memory ring of 256 events, process-lifetime monotonic `seq`, no persistence, and no replay endpoint; diagnostic lag drops diagnostics only.
- Sanitization allowlist: phase, route, project ID, model spec, operation ID, generation, outcome/code, and bounded token fingerprint. Exclude raw tokens, prompts, transcript, stderr, filesystem paths, and secrets; cap each string at 128 bytes and serialized payload at 2 KiB.
- Add only additive `phase` (and current diagnostic sequence if needed) to existing status. Preserve reconnect ordering exactly: `epoch → status → history → diagram`.
- Acceptance: tests prove atomic state/event ordering, bounded retention, sanitization limits, unchanged browser messages, and snapshot ordering.

### 6. Documentation, compatibility, and cutover boundary

- Update `README.md`, `docs/concurrency-and-test-hazards.md`, `docs/observability-and-coverage-handoff.md`, and `docs/rust-typescript-migration-handoff.md`.
- Document `SWITCHBOARD_SESSION_TOKEN` as an opaque per-process leg token, distinct from persistent Pi session IDs; document callback identity fields, `SWITCHBOARD_LOG`, `SWITCHBOARD_LOG_FORMAT`, and existing environment contracts.
- Require a separate homelab PR for environment/template changes and pinned-tag deployment. Make no homelab edits here; retain legacy Python and one-change rollback until host STT/SSH/TTS validation passes.
- Acceptance: run `cargo fmt --all -- --check`, `cargo test --locked`, Clippy with `-D warnings`, legacy unittest discovery, `npm test`, and static diff verification; then perform homelab hardware and rollback checks.

## Rejected alternatives and residual risks

Rejected: public lifecycle replay, durable journal/Postgres/Redis, run queues, API-side lifecycle façade, persistent token reuse, new browser state machinery, and premature legacy deletion. Callback identity prevents stale delivery but is not authentication; live credentials, SSH, STT, TTS, and deployment behavior remain host-validation risks.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The revised plan corrects the compare and adversarial findings with concrete files, symbols, coordinator APIs, identity rules, adoption rollback semantics, model passthrough, diagnostics retention, failed-speak scope, per-slice race tests, public contracts, and homelab boundaries."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection and plan revision",
      "result": "not-run",
      "summary": "Read-only planning; no source files edited."
    }
  ],
  "validationOutput": [
    "Defined exact per-slice acceptance checks and preserved existing Rust, legacy, browser, static, and deployment gates."
  ],
  "residualRisks": [
    "Callback identity is correlation, not authentication.",
    "Live STT, SSH, TTS, credentials, hardware, and rollback require homelab validation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; revised migration plan only.",
  "reviewFindings": [
    "high: src/models.rs:216-230 - unavailable catalogs previously rejected provider-qualified passthrough.",
    "high: src/pbx.rs:636-663,1248-1264 - leg adoption previously mutated visible state before startup and intro completion.",
    "high: extensions/agent-switchboard.ts and src/api.rs:833-913 - callbacks lacked process and operation identity.",
    "high: src/api.rs:30-54 - API-owned lifecycle state conflicted with coordinator ownership.",
    "medium-high: lifecycle exposure, sequence retention, sanitization, and snapshot ordering were previously unresolved.",
    "medium-high: stale checks were incomplete across awaited transition and callback paths.",
    "medium: failed-speak fallback scope was previously undecided.",
    "medium: token and logging environment contracts lacked documentation."
  ],
  "manualNotes": "No unresolved parent product decisions remain in migration scope; deployment remains a separate homelab PR.",
  "notes": ""
}
```

[38;2;136;136;136m✻ Turn took 1m 50s (Total time 1m 49s · 1 turn)[0m