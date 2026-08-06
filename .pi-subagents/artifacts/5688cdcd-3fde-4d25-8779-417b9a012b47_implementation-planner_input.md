# Task for implementation-planner

Revise plan_v9 using review_v9 and all prior contracts. This is the last planned revision before implementation. Do not edit source files and do not reopen the approved fail-closed SSH policy: current remote same-session keep_context redial must settle operator with remote_shutdown_unverified and never reuse the session.

Close these exact blockers with mechanisms, ownership, call paths, and deterministic tests:
1. Callback correlation: inspect the actual ExtensionAPI and current extension payloads. Do not invent operation metadata. Either define a real toolCallId registration/mapping before callbacks, or explicitly make callbacks leg-scoped using the current in-flight coordinator operation and per-process leg token, with one-operation-at-a-time invariants that reject callbacks when no matching active operation exists. Tool execution start/end correlation remains internal to PiSession and must require matching successful completion for speech fallback. State exact request bodies and tests.
2. Status/catalog projection: define an immutable independently readable CatalogSnapshot or explicitly exclude catalog state from status. Do not read coordinator C and PBX/catalog P under nested locks. Define freshness semantics, publication order, and tests proving coherent status without blocking /speak, /leg-state, or /status while turns hold PBX locks.
3. WebSocket barrier: define Connection/Writer ownership, epoch allocation, registration-before-snapshot, snapshot cursor, buffering/barrier release, replacement/disconnect cancellation, lag handling, and one writer path for pong, command errors, snapshots, events, and audio. Preserve exact existing wire framing: JSON metadata followed by binary audio, newline JSONL RPC, reconnect order epoch→status→history→diagram. Add ordering and replacement tests.
4. Candidate staging rollback: make remote extension staging and host cache a candidate-owned transaction with cleanup/invalidation on startup, intro, adoption, rescue, or cancellation failure. No remote artifact or stale cache survives an unadopted candidate unless explicitly documented. Add failure and rescue tests.
5. Idle/shutdown: name Coordinator commands and linearization for spawn_idle_worker/return_if_idle and api::shutdown. Define cancellation/task ordering, leg quiescence, callback rejection, terminal events, and tests.
6. Speech deadline: choose one exact end-to-end deadline constant and propagate cancellation from extension AbortSignal through HTTP handler, process_speech, TTS, audio reservation, and writer enqueue. Define worker-drop/timeout/late-result semantics and ensure fallback is not suppressed. Add timeout-vs-commit, queue-full, and reconnect tests.

Also explicitly include the previously approved model passthrough, fresh stateless status, candidate side-effect gating, lock ownership/order, browser outbox/playback races, documentation updates, and full acceptance commands. End with an implementation-ready file/symbol map and no vague preservation language.

## Context from phase 'review_v9'
# Handoff Output: review_v9
Status: success
Verdict: REVISE
Timestamp: 1786007827

## Content
# Adversarial review

1. **High: operation registration still cannot correlate callbacks.**  
   `src/pi_client.rs:215-229` sends only prompt/steer text, while tool events are parsed at `:414-438`. The extension ignores `_toolCallId` and `/speak` currently sends only `{text}` (`extensions/agent-switchboard.ts:99-106`). Plan §3 creates an internal operation ID but does not define how the Pi-generated `toolCallId` is registered and mapped before callbacks arrive. Legitimate callbacks may be rejected, or stale callbacks accepted under a broad active-operation match.

2. **High: status freshness conflicts with the lock table.**  
   Catalogs remain owned by `Switchboard` behind PBX lock `P`, while status must combine fresh coordinator state with catalog state. The plan forbids nesting `P` with `C`, but defines no immutable catalog snapshot or atomic cross-owner query. Reading `C` then `P` can produce route/model/catalog from different lifecycle points; holding `P` during projection can block callbacks, reproducing the v8 liveness risk.

3. **High: WebSocket registration/snapshot ordering is asserted, not implementable.**  
   “Register before snapshot” and “per-connection writer” do not define the atomic delivery barrier that prevents live events interleaving with `epoch -> status -> history -> diagram`. The current reader sends responses directly (`src/api.rs:1130-1160`), so the plan must explicitly route pong, command errors, snapshot, and broadcast events through the same writer, with replacement/disconnect cancellation and a snapshot cursor.

4. **High: candidate staging has no rollback.**  
   `src/pbx.rs:720-731, 951-1040` stages an extension remotely and caches the host result before startup/intro succeeds. Plan §4 says candidate failure closes candidate resources, but does not delete the staged remote file, invalidate the cache, or define rollback when adoption fails. “No partial publication” only covers in-memory lifecycle state. Add explicit staging transaction/cleanup and a failure test.

5. **Medium: idle and shutdown callers are not concretely routed through Coordinator.**  
   Existing `spawn_idle_worker` and `api::shutdown` directly lock PBX and call `return_if_idle`/`shutdown` (`src/api.rs:259-290`). The plan names these callers rhetorically but the Coordinator API list omits idle/shutdown commands, cancellation linearization, and callback ordering. Specify those command paths and tests, rather than relying on “cross it.”

6. **Medium: the canonical speech deadline is not actually shared.**  
   The extension currently uses `AbortSignal.timeout(30_000)` (`extensions/agent-switchboard.ts:99-106`), while TTS also has its own 30-second client timeout (`src/audio.rs:54-93`). Plan §6 says 25 seconds end-to-end but does not specify the extension constant, HTTP deadline propagation, or how worker shutdown cancels an in-flight request. A timed-out tool can still complete unless these are explicit.

The SSH same-session policy itself is correctly fail-closed: the current adapter is explicitly unverified, no candidate starts, and no persistent session is reused. Documentation scope is now allowed and the model passthrough/callback gating claims are directionally correct, but the gaps above remain implementation-blocking.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "The fail-closed SSH decision is honored, but callback correlation, status lock linearization, WebSocket snapshot barriers, candidate staging rollback, and exact speech deadline propagation remain underspecified."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Read-only inspection cited concrete current callers, symbols, extension payloads, lock ownership, and prior review requirements."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository, plan_v9, review_v8, prior handoffs, and concurrency documentation inspection",
      "result": "passed",
      "summary": "Checked SSH callers, lifecycle paths, callback payloads, locks, WebSocket delivery, speech transport, staging, and compatibility contracts."
    }
  ],
  "validationOutput": [
    "Current SSH same-session redial is fail-closed without a remote lock claim.",
    "The remaining gaps are concrete design omissions, not source-test failures."
  ],
  "residualRisks": [
    "Stale or legitimate callbacks may be misclassified without toolCallId-to-operation registration.",
    "Status can be incoherent or callback-blocking without a P-free catalog projection.",
    "Snapshot/live WebSocket events can reorder without an atomic writer barrier.",
    "Failed candidates can leave remote staged artifacts and stale cache entries.",
    "Speech timeout can still permit late audio or fallback suppression."
  ],
  "noStagedFiles": true,
  "diffSummary": "Planning-only adversarial review; no source files changed.",
  "reviewFindings": [
    "high: src/pi_client.rs:215-229 and extensions/agent-switchboard.ts:99-106 - operation identity has no callback registration mapping",
    "high: src/api.rs:30-55 and plan lock table - fresh status has no atomic catalog/lifecycle projection",
    "high: src/api.rs:1130-1160 - WebSocket writer and snapshot barrier remain unspecified",
    "high: src/pbx.rs:720-731,951-1040 - candidate extension staging lacks rollback",
    "medium: src/api.rs:259-290 - idle/shutdown Coordinator command paths are unnamed",
    "medium: src/audio.rs:54-93 and extensions/agent-switchboard.ts:99-106 - 25-second speech deadline is not shared"
  ],
  "manualNotes": "Revise before implementation; preserve the fail-closed SSH policy and avoid reintroducing remote lock or shutdown claims."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 4s (Total time 3m 4s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v10.md
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