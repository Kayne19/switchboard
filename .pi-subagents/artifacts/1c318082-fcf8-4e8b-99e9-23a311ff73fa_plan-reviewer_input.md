# Task for plan-reviewer

Review `plan_v3` as the final architecture gate. Verify it directly closes every blocker in `review_v2`: same-session redial quiescence/no concurrent process, a real leg-scoped callback mechanism with no invented per-turn propagation, one sole mutable lifecycle owner with duplicate fields removed, rejected provisional callbacks and fallback behavior, plus all earlier compatibility, trace, sanitization, docs, and test requirements. Reject any remaining ambiguity or god-object scope. Read-only. End exactly with `VERDICT: APPROVE` or `VERDICT: REVISE`.

## Final plan
# Handoff Output: plan_v3
Status: success
Verdict: (none)
Timestamp: 1786004093

## Content
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

## Prior review
# Handoff Output: review_v2
Status: success
Verdict: REVISE
Timestamp: 1786003809

## Content
# Adversarial review

V2 closes the prior model, lifecycle exposure, failed-speak, documentation, and slice-test placement findings. Remaining blockers:

1. **Critical:** `src/pbx.rs:1234-1252`, `src/pbx.rs:755-756`, `README.md:112-115`  
   `redial(keep_context=true)` reuses the persistent `session_id`, but slice 2 starts the candidate before closing the authoritative process. Two Pi processes can concurrently access the same session file. Define locking, history cloning, or a quiesce/rollback tradeoff, with a test.

2. **High:** `extensions/agent-switchboard.ts:41-58,100-211`, `src/pi_client.rs:220-270`  
   Per-operation `operation_id` and `generation` have no propagation mechanism. The extension receives process-start environment values, while `prompt`/`steer` currently carry only message text. Specify the exact JSONL fields and ExtensionAPI access path; otherwise callbacks cannot carry the required full identity.

3. **High:** `src/pbx.rs:163-190,590-709,1187-1330`  
   Adding `CallLifecycle` “beside” `Switchboard` does not state which existing route/project/session/model fields are removed. Without an explicit transfer of ownership, split lifecycle state remains; wrapping both risks a new god object. Define `Switchboard` as an adapter and `CallLifecycle` as the sole state owner.

4. **High:** `src/api.rs:833-905`, slice 2  
   Candidate startup/intro can invoke speak, diagram, or leg-state callbacks while the prior leg remains authoritative. Specify whether these callbacks are rejected, buffered, or staged, and ensure rejected candidate speech does not suppress fallback synthesis.

Residual risks: callback identity remains correlation rather than authentication; live SSH, STT, TTS, credentials, and rollback still require homelab validation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Four remaining blockers are reported with concrete repository paths, line ranges, failure modes, and required corrections."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection",
      "result": "not-run",
      "summary": "Read-only adversarial review."
    }
  ],
  "validationOutput": [
    "Checked revised plan claims against Pi session reuse, callback transport, lifecycle ownership, and candidate adoption paths."
  ],
  "residualRisks": [
    "Callback identity is not authentication.",
    "Live deployment and hardware behavior remain unverified."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed.",
  "reviewFindings": [
    "critical: src/pbx.rs:1234-1252 - candidate redial can concurrently reuse the authoritative persistent session_id.",
    "high: extensions/agent-switchboard.ts:41-58 and src/pi_client.rs:220-270 - per-operation callback identity propagation is unspecified.",
    "high: src/pbx.rs:163-190 - CallLifecycle and Switchboard ownership boundary remains ambiguous.",
    "high: src/api.rs:833-905 - provisional candidate callback side effects lack a defined policy."
  ],
  "manualNotes": "Prior findings are mostly addressed, but these blockers must be resolved before implementation."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 14s (Total time 3m 14s · 2 turns)[0m

## Original comparison audit
# Handoff Output: compare
Status: success
Verdict: (none)
Timestamp: 1786003098

## Content
# Architecture audit: reference vs. switchboard

## Verdict

Switchboard’s genuine architectural weakness is not lack of infrastructure; it is split ownership of the live call lifecycle. The highest-value transfer is a single runtime coordinator with typed, ordered lifecycle events. Durable queues, Postgres, Redis, Magi-style FSMs, and React state machinery are domain-specific and should not be copied.

Evidence below distinguishes direct observations from inferred risk. Confidence is high unless marked conditional.

## Prioritized gap register

| Priority | Gap and evidence | Blast radius / risk | Migration |
|---|---|---|---|
| P0 | **Lifecycle ownership is split.** PBX route/session fields (`src/pbx.rs:166-240`) coexist with API generations, operations, task cancellation, and status snapshots (`src/api.rs:30-54,176-191,302-316`); `live_leg_state()` mirrors PBX state (`src/pbx.rs:268-280`). | High: rescue, transfer, and delivery can observe different truths. Inference supported by distributed implicit states and absent canonical transition record. | Introduce one `CallLifecycle`/coordinator owning route, leg identity, generation, operation phase, and terminal outcome. Make API a command/event adapter. |
| P0 | **Leg adoption is not transactional.** Transfer/redial writes route/project/model/session fields before awaited `start_agent` (`src/pbx.rs:636-663,1248-1264`). | Critical for cancellation during setup: project-looking state may exist without an adopted agent; rescue may close the wrong active leg. | Add one PBX boundary: prepare candidate leg, start it, atomically adopt on success, rollback on cancellation/failure. |
| P0 | **Stale-result protection is incomplete.** Rust `handle_agent` lacks the legacy post-`prompt` session check (`src/pbx.rs:491-588`; legacy check `legacy/backend/pbx.py:499-505`, test `legacy/tests/test_pbx.py:770-797`). | High: late output can be delivered after rescue or redial. API task abortion is not sufficient because cancellation races with process completion. | Carry `(operation_generation, leg_id/session_id)` through dispatch and reject mismatches at the PBX boundary. Add race tests. |
| P1 | **No canonical event contract.** Browser events are heterogeneous and `web/browser.d.ts:1-39` permits arbitrary fields; status is a mutable snapshot; there is no ordered lifecycle trace or terminal outcome object. | High: reconnect, debugging, and exact client reconciliation remain ad hoc. | Define typed internal `LifecycleEvent` with sequence, operation, generation, leg, phase, code, payload, and terminal status. Serialize it for WebSocket; derive snapshots from it. |
| P1 | **Phase/state visibility is implicit.** Effective route states are distributed across PBX, API, and browser (`src/pbx.rs:369-711,1187-1380,1477-1532`; `src/api.rs:318-646`). | Medium-high: operators and tests cannot reliably distinguish setup, active turn, transfer, rescue, failed leg, and terminal states. | Expose a compact caller-facing phase enum and transition trace. Do not expose Pi’s internal reasoning phases. |
| P1 | **Testable boundaries are behind the legacy baseline.** Rust has 46 tests versus 143 legacy tests; direct hangup, idle-drop, WebSocket behavior, many `PiSession::collect` branches, and exact traces are missing (`docs/observability-and-coverage-handoff.md:89-138`). | Medium-high: concurrency regressions are likely to escape review. | First test the coordinator seam: success, failed adoption, rescue races, stale delivery, idle drop, terminal event ordering. |
| P2 | **Adapter outcomes are not uniformly explicit.** `PiSession` owns process/JSONL mechanics (`src/pi_client.rs:516-700`) and detects tool signals (`:367-454`), while PBX applies semantics. `/speak` and `/diagram` bypass turn serialization (`src/api.rs:833-913`); failed speak can suppress fallback because “spoken” is marked at signal start. | Medium: transport completion and domain observation are conflated. | Keep adapters, but return typed `Started/Succeeded/Failed/Cancelled` outcomes and correlate callbacks with operation/leg identity. |
| P2 conditional | **Persistence/runtime separation is undocumented or ambiguous.** `SWITCHBOARD_STATE_DIR` and `Config.session` are read, but Rust intentionally drops calls and in-memory history on restart (`README.md:250-253`; `src/history.rs:31-101`). | Conditional: no defect for a deliberately ephemeral single-caller service; high only if restart replay or auditability becomes a requirement. | Document ephemeral semantics now. Add a `HistoryStore` boundary only when durable history is product-required; do not introduce a run database preemptively. |
| P3 | **Task-shaped decomposition is partial, not absent.** `SttAdapter`, `Speaker`, and `PiSession` are useful boundaries (`src/audio.rs:104-353`, `src/pi_client.rs`), and PBX owns routing semantics. | Low-medium: further splitting could merely duplicate state. | Preserve these adapters; formalize typed inputs/outputs rather than creating new layers. |

## What should not be copied

- Postgres run queues, leases, Redis fanout, Auth0/M2M, per-user limits, and React optimistic state: these solve multi-user durability and deployment concerns absent from switchboard’s one-caller scope.
- The reference’s RAG, memory, ingestion, and Magi FSMs: their phases are domain-specific. Switchboard needs a small call/leg lifecycle, not a universal orchestration framework.
- Durable replay: transcript history is not lifecycle history, but making both durable is a product decision, not an architectural prerequisite.
- Provider documentation wholesale: the reference claims transport-only provider adapters, yet `openAI_caller.py:531-829` still owns repeated tool loops. Adopt enforced interfaces and tests, not the claim alone.

## Proposed target boundary map

`WebSocket/HTTP/extensions` → validate into typed commands  
`CallLifecycle coordinator` → sole owner of route, leg, generation, phase, adoption, terminal result  
`Turn dispatcher` → serializes operations and invokes the active leg  
`PiSession adapter` → process, JSONL, timeout, signal parsing; no route mutation  
`STT/TTS adapters` → audio transport outcomes; no lifecycle ownership  
`Lifecycle event journal/broadcaster` → in-memory monotonic sequence, snapshot projection, reconnect epoch  
`Browser` → projection only  
`Optional HistoryStore` → restart persistence, added only by explicit product requirement  
`Homelab deployment` → environment, secrets, registry, systemd, persona, cutover

## Recommended migration order

1. Add lifecycle/identity types and exact trace assertions without moving infrastructure.
2. Implement atomic leg adoption/rollback and post-prompt identity checks.
3. Replace mutable status publication with typed lifecycle events plus an in-memory sequence.
4. Normalize Pi, speak, diagram, STT, and TTS completion outcomes; correlate every callback.
5. Fill WebSocket, hangup, idle, and race coverage.
6. Decide persistence separately; add storage only if restart replay or audit requirements justify it.

The reference’s strongest transferable doctrine is explicit ownership and observable contracts. Switchboard’s intentional ephemerality and existing transport adapters are sound domain choices.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only comparison identifies prioritized gaps, domain differences not to copy, migration order, risks, and a target boundary map using concrete reference and switchboard paths."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Each major claim distinguishes direct evidence from inference and includes blast radius, confidence, or conditional applicability."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection and handoff synthesis",
      "result": "not-run",
      "summary": "No repository edits or tests were run."
    }
  ],
  "validationOutput": [
    "Compared the completed reference and switchboard architecture handoffs.",
    "Repositories remain unmodified."
  ],
  "residualRisks": [
    "Persistence requirements remain a product decision.",
    "The proposed coordinator boundary requires concurrency tests before implementation is considered safe."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; architecture audit only.",
  "reviewFindings": [
    "high: split lifecycle ownership and non-transactional leg adoption can produce inconsistent route/session state.",
    "high: missing post-prompt session identity validation permits stale result delivery.",
    "medium: event and phase contracts are implicit, limiting replay, reconciliation, and exact testing."
  ],
  "manualNotes": "Durable run infrastructure and domain-specific reference FSMs were deliberately excluded as non-transferable."
}
```

[38;2;136;136;136m✻ Turn took 1m 19s (Total time 1m 19s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/review_v3.md
Do not call contact_supervisor merely because no write-capable tool is available.
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```