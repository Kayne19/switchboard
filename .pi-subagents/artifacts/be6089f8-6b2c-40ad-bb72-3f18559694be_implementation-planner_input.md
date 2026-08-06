# Task for implementation-planner

Produce the final implementation plan by revising `plan_v2` against `review_v2`. Resolve these blockers explicitly, with exact mechanisms and tests:

1. Redial session reuse: when `keep_context=true` reopens the same persistent Pi session file, the old authoritative process must be quiesced and fully closed before starting the candidate. State the tradeoff: no simultaneous preservation during same-session redial; if reopen fails, settle to operator (or define a safe rollback that does not touch the session file concurrently). Add a deterministic test proving no concurrent same-session processes and correct failure outcome. New-session redial/transfer may use the candidate path, but candidate adoption remains transactional.
2. Callback identity: do not promise impossible per-turn metadata through static process env. Define the exact external mechanism as a per-process `leg_token` embedded in `SWITCHBOARD_SPEAK_URL`, `SWITCHBOARD_DIAGRAM_URL`, and `SWITCHBOARD_STATE_URL` (or request body), validated at callback ingress. Keep `operation_id` and `generation` internal to the coordinator/Pi turn identity and attach them when the coordinator accepts a leg-scoped callback; document that callback correlation is not authentication and that late callbacks from an invalidated leg are rejected. If the existing Pi RPC can safely carry per-turn metadata to ExtensionAPI, specify the exact JSONL fields and API access path; otherwise explicitly do not add fake per-operation callback fields.
3. Ownership: define `CallLifecycle` as the sole mutable lifecycle state machine. `Switchboard` becomes a facade/adapter containing immutable configuration, registry/model/process/audio dependencies and delegating all route/project/model/session/leg/generation/phase/trace mutations to `CallLifecycle`; remove those duplicate fields from `Switchboard` rather than wrapping them. Define the narrow coordinator commands/queries and one `linearize()` boundary; no API lifecycle mirrors.
4. Candidate callbacks: while a candidate is preparing/starting/intro, its leg token is not current. `/speak`, `/diagram`, `/leg-state`, and `/thinking` callbacks are rejected with bounded machine-readable failure, never buffered, and cannot set agent-spoke/suppress fallback. Candidate intro output is written/transcript-only unless the candidate is adopted. Add tests.

Preserve the other corrected requirements from `plan_v2`: unavailable-catalog provider-qualified passthrough, failed-speak fallback, diagnostics-only bounded lifecycle ring, sanitized additive phase status, exact slice-local race tests, ephemeral one-caller semantics, no Postgres/Redis/run queue, no homelab edits, and legacy compatibility. Do not edit source files. End with exact file/symbol mapping, acceptance commands, and only genuine unresolved decisions.

## Plan v2
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

## Review v2
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
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v3.md
Do not call contact_supervisor merely because no write-capable tool is available.
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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