# Task for implementation-planner

Revise the migration plan using the completed `compare` handoff and the adversarial `review` handoff. Preserve the good coordinator-first direction, but correct every reviewer finding before implementation. The revised plan must: (1) define one coordinator-owned linearization boundary and explicit command/query APIs so `api.rs` no longer owns route/generation/session lifecycle state; (2) define a distinct per-process leg token separate from persistent Pi session IDs and propagate/validate operation identity for every agent callback and every awaited side-effect commit; (3) specify candidate-leg ownership, adoption commit point, intro failure behavior, rescue-during-setup rollback, and prior-leg/operator fallback; (4) pin unavailable-catalog provider-qualified model passthrough compatibility; (5) choose lifecycle exposure as diagnostics-only internal typed events plus additive current phase in existing status, not a new public lifecycle replay protocol; define sequence/journal retention, sanitization allowlist/size limits, and snapshot ordering; (6) decide failed-speak fallback scope explicitly and add a regression test or mark it as a documented non-goal; (7) place executable race tests in the slices that introduce each guarantee; (8) document new public environment/token contracts and the separate homelab PR boundary. Keep one-caller ephemerality, no Postgres/Redis/run queue, no homelab edits, and no premature legacy deletion. Do not edit source files. End with exact per-slice acceptance checks and unresolved parent decisions only if genuinely unavoidable.

## Existing plan
# Handoff Output: plan
Status: success
Verdict: (none)
Timestamp: 1786003241

## Content
# Switchboard lifecycle migration plan

**Scope:** read-only plan; no source edits. Highest risks are P0 split ownership (`src/api.rs:30-54`, `src/pbx.rs:166-240`), non-atomic adoption (`src/pbx.rs:636-663`, `1248-1264`), and stale delivery (`src/pbx.rs:491-588`).

## Target state and ownership

1. Make `Switchboard` the sole `CallLifecycle` owner; do not add a parallel orchestration framework. Consolidate route, project, model, active/pending leg, session identity, generation, phase, and terminal outcome there.
2. Use phases `OperatorReady`, `ProjectPreparing`, `ProjectStarting`, `ProjectIntro`, `ProjectActive`, `TurnRunning`, `Returning`, `Redialing`, `Rescuing`, and `Shutdown`; failures are terminal outcomes that settle to `OperatorReady` or `Shutdown`, never a stranded project phase.
3. Represent identity as `{operation_id, generation, leg_id/session_token}`. Represent outcomes as `Succeeded`, `Failed{code}`, `Cancelled`, or `Superseded`.
4. Emit `LifecycleEvent {seq, operation_id, generation, leg_id, phase, kind, outcome, sanitized payload}`. `seq` is monotonic for process lifetime; the bounded journal is in-memory only.
5. `src/api.rs` validates HTTP/WebSocket commands, owns queues, task handles, audio ordering, and event broadcasting; it may request lifecycle commands but cannot mutate route or generation.
6. `src/pi_client.rs` owns JSONL/process/SSH mechanics only; `PiSession::{start,prompt,steer,close,same_session}` returns typed transport/tool outcomes and never changes routing.
7. `src/audio.rs`, `src/registry.rs`, `src/models.rs`, and `src/history.rs` remain task/value adapters; `web/` is a projection; extensions request actions only; `legacy/` remains compatibility baseline; homelab owns deployment and secrets.

## Ordered migration slices

1. **Trace seam, no behavior change:** add lifecycle types/events beside `Switchboard` in `src/pbx.rs`; route `announce_route` through an event callback; add exact trace tests to existing `fake_runtime()` tests. Preserve `Event::Json`, all HTTP/WS shapes, and snapshot order.
2. **Atomic leg adoption:** refactor `transfer`, `dial`, `set_model`/redial, `drop_agent`, and `start_agent` in `src/pbx.rs` to prepare a candidate, start it, then adopt route/project/model/session fields in one commit. On cancellation/failure close the candidate and settle to the prior valid leg or operator; never expose a project route without its adopted session.
3. **Canonical stale checks:** pass `OperationIdentity` through `handle`, `handle_agent`, transfer/redial, `process_turns`, `deliver_turn_if_current`, `deliver_page_reply_if_current`, and `synthesize_reply_if_current` in `src/api.rs`; re-check generation and `PiSession::same_session()` after every awaited prompt and before route, transcript, reply, or audio commit. Delete duplicate API generation mutation after coordinator ownership is proven.
4. **Journal and projection:** replace mutable status publication in `src/api.rs::{status_snapshot,publish_status,current_status}` with coordinator snapshot projection plus a bounded lifecycle journal/broadcaster. Serialize additive lifecycle events for WebSocket while retaining `epoch/status/history/diagram` reconnect ordering and existing browser messages.
5. **Normalize adapter outcomes:** extend `src/pi_client.rs::{Turn,Signal,collect}` to distinguish tool started/completed/failed; correlate `/speak`, `/diagram`, and `/leg-state` callbacks with session token and operation identity. Preserve sentinel return, JSONL protocol, and existing external payloads; fix failed-speak fallback only after compatibility tests pin the intended behavior.
6. **Coverage completion:** add deterministic tests in `src/pbx.rs` for transfer/redial adoption, intro failure, return, hangup, idle, shutdown, and stale prompts; in `src/api.rs` for rescue during STT/turn/transfer/redial, stale audio, WS snapshot/lagging, and endpoint cancellation; in `src/pi_client.rs` for terminal outcomes. Extend `tests/test_protocol.mjs`, `legacy/tests/test_pbx.py`, `legacy/tests/test_piclient.py`, and model compatibility tests.
7. **Documentation and deployment:** update `README.md`, `docs/concurrency-and-test-hazards.md`, `docs/observability-and-coverage-handoff.md`, and `docs/rust-typescript-migration-handoff.md` with phase/event ownership, bounded retention, ephemeral restart semantics, and `SWITCHBOARD_LOG`/`SWITCHBOARD_LOG_FORMAT`. Cut over only through a separate homelab pinned-tag PR; retain the Python tag and one-change rollback.

## Invariants, stop conditions, rejected alternatives

- No stale generation or leg identity may mutate route, transcript, reply, TTS, diagram, or status; every adopted child is closed on cancellation; every terminal event follows its operation’s start event.
- Stop and revert the current slice if any existing wire shape changes, a trace shows duplicate/non-monotonic sequence, a rescue leaves an orphan process, or any Rust/legacy/Node/static/Clippy gate fails.
- Rejected: Postgres/Redis leases, durable replay, React state, a universal FSM, new process traits, early Python deletion, and treating transcript history as lifecycle persistence; these add scope without single-caller product semantics.
- Unresolved for the parent: whether lifecycle events are public WS data or diagnostics only; exact journal retention/replay; restart durability and idempotency requirements; final phase vocabulary; whether failed `speak` fallback is in this migration; Rust/Python cutover timing and STT equivalence threshold.

## Validation contract

Run `cargo fmt --all -- --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, `python3 -m unittest discover -s legacy/tests`, `npm test`, and `git diff --exit-code -- static`; require exact traces for every listed success, failure, stale-work, rescue, and shutdown path, then perform homelab hardware/SSH/STT/TTS and rollback checks before deleting Python.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Plan names concrete severity-rated findings, exact files and symbols, target ownership, FSM states, event contracts, migration order, tests, deployment compatibility, rollback, and unresolved decisions."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository and handoff inspection",
      "result": "not-run",
      "summary": "Read-only planning; no tests or source changes."
    }
  ],
  "validationOutput": [
    "Defined a coordinator-first migration with compatibility-preserving slices and exact validation gates."
  ],
  "residualRisks": [
    "Public lifecycle-event exposure, durability, phase vocabulary, speak fallback scope, and deployment cutover remain parent decisions.",
    "Hardware, credentials, model quality, and rollback require homelab validation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; implementation plan only.",
  "reviewFindings": [
    "high: src/api.rs:30-54 and src/pbx.rs:166-240 - lifecycle ownership is split.",
    "high: src/pbx.rs:636-663,1248-1264 - leg adoption mutates visible state before startup succeeds.",
    "high: src/pbx.rs:491-588 - stale post-prompt session identity validation is absent.",
    "medium: src/api.rs:176-191,302-316 - status/events lack canonical ordered lifecycle trace."
  ],
  "manualNotes": "The plan deliberately excludes reference-specific durable infrastructure and premature legacy removal."
}
```

[38;2;136;136;136m✻ Turn took 2m 18s (Total time 2m 17s · 1 turn)[0m

## Adversarial review
# Handoff Output: review
Status: success
Verdict: REVISE
Timestamp: 1786003456

## Content
# Adversarial review

1. **High:** `src/models.rs:216-230` rejects provider-qualified models when the catalog is unavailable, contrary to `legacy/backend/models.py:198-214` and the migration contract. “Model compatibility tests” is not a correction. Fix this in the model slice and pin passthrough behavior.

2. **High:** The proposed atomic adoption is underspecified. `src/pbx.rs:636-663` and `1248-1264` drop the old leg and mutate visible route fields before startup and intro completion. Define provisional-candidate ownership, the exact commit point, intro-failure behavior, and whether failure preserves the old leg or returns to the operator. Add rescue-during-setup tests in slice 2, not slice 6.

3. **High:** Identity correlation is incomplete. `SWITCHBOARD_SESSION_TOKEN` is derived from the persistent `session_id`, which redial intentionally reuses; it cannot distinguish old and new processes. `/speak` and `/diagram` currently carry no identity (`extensions/agent-switchboard.ts`, `src/api.rs:833-913`). Rotate a per-process leg token separately from the persisted Pi session ID, propagate operation identity, and validate every callback before transcript, audio, diagram, or status mutation.

4. **High:** “Switchboard is sole owner” conflicts with retaining API-owned `turn_generation`, `operation_transition`, `active_session`, and cancellation state (`src/api.rs:30-54`). The plan needs explicit coordinator command/query APIs and one linearization boundary; otherwise it adds a state-machine façade over the same split ownership. Do not await broadcaster callbacks while holding coordinator state.

5. **High:** Slice 4 says lifecycle events will be serialized onto WebSocket, while the plan simultaneously lists public-vs-diagnostic exposure as unresolved. Decide that contract first. Define atomic state/event commit, sequence allocation, journal retention, replay/lag behavior, and ordering relative to `epoch → status → history → diagram`. Sanitization needs an allowlist and size limits, not merely the word “sanitized.”

6. **Medium-high:** Post-prompt `same_session()` checks alone are insufficient. Transfer, redial, startup, and callback paths contain additional awaits and side effects. Validate identity immediately before every route/session/history/audio/diagram commit. Move those race tests into the slices that introduce the checks.

7. **Medium:** The first slice’s `announce_route` callback can only trace route snapshots, not preparation, startup, intro, cancellation, terminal outcomes, or shutdown. It cannot establish the promised canonical lifecycle trace without a coordinator transition seam. Each slice needs its own executable exit tests instead of deferring critical validation to “coverage completion.”

8. **Medium:** The known failed-`speak` behavior still suppresses fallback synthesis (`src/pi_client.rs:367-454`, `src/pbx.rs:1459`; documented in `docs/observability-and-coverage-handoff.md:61-74`). Either fix it based on tool completion/error, or explicitly mark the README-promised fallback as an accepted non-goal with a regression test.

9. **Medium:** New identity/logging variables must be documented as public contracts. `SWITCHBOARD_LOG` and `SWITCHBOARD_LOG_FORMAT` are already missing from `docs/rust-typescript-migration-handoff.md`; the token contract is also absent. The plan must require the corresponding homelab PR and must not imply deployment from this repository.

Residual risk remains around restart semantics, callback spoofing (identity prevents stale work but is not authentication), and live STT/SSH validation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only adversarial review identified concrete corrections with severity and repository evidence across lifecycle ownership, adoption, identity, model compatibility, event contracts, testing, and deployment."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository and handoff inspection",
      "result": "not-run",
      "summary": "Review-only task; no tests or source changes."
    }
  ],
  "validationOutput": [
    "Compared the plan with switchboard and adjacent repository instructions, source/docs, and reference, switchboard, and compare handoffs."
  ],
  "residualRisks": [
    "Restart durability and lifecycle-event exposure remain product decisions.",
    "Callback identity is not authentication.",
    "Live STT, SSH, credentials, and rollback behavior remain unverified."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; adversarial plan review only.",
  "reviewFindings": [
    "high: src/models.rs:216-230 - unavailable catalogs violate provider-qualified passthrough compatibility.",
    "high: src/pbx.rs:636-663,1248-1264 - atomic adoption and rollback semantics are underspecified.",
    "high: extensions/agent-switchboard.ts and src/api.rs:833-913 - callback identity cannot currently reject stale process callbacks.",
    "high: src/api.rs:30-54 - coordinator ownership remains contradicted by API-owned lifecycle state.",
    "high: plan slice 4 - public WebSocket lifecycle exposure is unresolved but treated as implementation scope.",
    "medium-high: stale checks are deferred too late and are incomplete across awaited transition paths.",
    "medium: failed speak suppresses fallback synthesis and lacks a firm scope decision.",
    "medium: public environment-contract documentation is incomplete."
  ],
  "manualNotes": "The plan has a sound direction but requires these corrections before implementation.",
  "notes": "Review verdict is revision-required."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 30s (Total time 3m 29s · 2 turns)[0m

## Comparison audit
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
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v2.md
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