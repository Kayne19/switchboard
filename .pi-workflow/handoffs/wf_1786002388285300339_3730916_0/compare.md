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