# Task for implementation-planner

Revise plan_v6 using review_v6. Close all six findings with exact mechanisms, ownership boundaries, propagation paths, and deterministic tests. Do not edit source files. Preserve all previously approved behavior, compatibility, and scope decisions.

Required corrections:
1. Generation authority: CallLifecycle is the sole owner of current generation. Remove generation ownership from DeliveryState; reservations carry a captured identity only. Define one coordinator transaction/order that advances lifecycle generation and cancels/finalizes affected audio reservations before any finish_audio can commit. Add timeout-versus-transition race tests.
2. Remote input validation: require POSIX environment-name validation before emitting any shell export, reject invalid names and unsafe values with bounded errors, and safely handle option-like SSH hosts using an explicit argument strategy. Preserve shell quoting and session identity validation. Add tests for invalid names, leading-dash hosts, metacharacters, and normal inputs.
3. Lock directory replacement race: specify a real descriptor-relative no-follow algorithm whose held directory FDs prevent namespace replacement between ancestor traversal and lock-file open, with inode/device or equivalent identity checks where needed. Define secure owner/mode checks and the exact Result/error path. Add deterministic pre-existing symlink and replacement-race tests; do not claim weaker checks prove safety.
4. Audio queue saturation: define finish_audio/oneshot behavior when bounded per-connection try_send cannot enqueue. No committed audio may be silently lost and no delivered:true may precede actual acceptance. Choose explicit block-with-deadline or fail-and-report semantics, finalize/cancel reservations consistently, and test queue-full plus written fallback behavior.
5. Candidate effective-thinking: preserve session_start thinking state without allowing candidate callback side effects. Define a private startup-result/staging channel owned by CandidateLeg, commit it only at adoption, and ensure candidate callbacks remain rejected externally. Add startup/adoption/failure tests proving thinking state is neither lost nor exposed prematurely.
6. Diagnostics authority: put the process-global ring and monotonic sequence in a separate DiagnosticTrace service. CallLifecycle emits bounded records through it but does not own the global counter/ring; define synchronization, retention, and sanitization ownership and tests.

End with exact file/symbol mapping, ownership table, race/security tests, acceptance commands, and no unresolved ambiguity for these findings.

## Context from phase 'review_v6'
# Handoff Output: review_v6
Status: success
Verdict: REVISE
Timestamp: 1786006066

## Content
# Adversarial review

1. **High: lifecycle generation has two authorities.**  
   Slice 1 assigns generation to `CallLifecycle`, while slice 5 makes `DeliveryState` own the current generation. Slice 2 advances it under the coordinator lock, then cancels audio separately. A `finish_audio` can interleave between those operations and observe inconsistent state. Make generation coordinator-owned and define one lock/order transaction for lifecycle advancement plus reservation cancellation.

2. **High: remote command validation leaves injection/option risks.**  
   `src/pi_client.rs:795-850` currently emits `export {name}=...` and passes `host` as an SSH argument. Plan_v6 only rejects NULs and bounds lengths. Invalid environment names can alter shell parsing, and option-like hosts can be interpreted as SSH options. Require POSIX environment-name validation and safe host argument handling, with tests.

3. **High: descriptor algorithm does not prove replacement-race rejection.**  
   `mkdirat` followed by `openat(O_NOFOLLOW)` and owner/mode checks can accept a different same-owner, mode-0700 directory substituted between operations. The plan claims replacement races are rejected but specifies no inode/identity verification. Clarify and test the required invariant.

4. **Medium: bounded `try_send` can silently lose committed audio.**  
   `finish_audio` marks a reservation ready and drains it, then `try_send`s to a bounded queue. Queue-full behavior is unspecified; `/speak` may already have returned `delivered:true`. Define whether full queues cancel, block, or report failure, and test it.

5. **Medium: candidate callback rejection loses effective thinking state.**  
   `extensions/agent-switchboard.ts` reports thinking during `session_start`, before candidate adoption. Since plan_v6 rejects all Candidate callbacks and forbids buffering, the new leg can become Active with `thinking_confirmed:false` permanently. Preserve this callback result through an explicit startup/adoption mechanism without exposing candidate state.

6. **Medium: diagnostics ownership contradicts process-global sequencing.**  
   Slice 1 puts lifecycle diagnostics inside `CallLifecycle`, while slice 8 requires a process-global 256-entry ring and monotonic sequence numbers. Store the ring/counter in a separate diagnostic service; lifecycle may only emit bounded records.

Existing v5 blockers are otherwise addressed: lock `Result` propagation and exit-75 settlement, atomic audio finalization intent, socket epoch capture/replacement cleanup, fresh status projection, and process/WebSocket ownership separation. Legacy sentinel/RPC behavior, unavailable catalogs, redial intent, and no homelab scope are explicitly retained, but the above ambiguities still permit security, delivery, and compatibility regressions.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "The five v5 blockers are addressed, but generation ownership, remote validation/race invariants, queue-full behavior, candidate callbacks, and diagnostics ownership remain underspecified."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Read-only inspection covered the plan, review_v5, src/api.rs, src/pi_client.rs, src/pbx.rs, extensions, browser protocol, and concurrency documentation."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository and plan inspection via read/grep",
      "result": "passed",
      "summary": "Read-only review; no source changes."
    }
  ],
  "validationOutput": [
    "Checked remote_argv callers, lifecycle mirrors, audio reservation paths, WebSocket protocol epochs, extension callbacks, and documented concurrency invariants."
  ],
  "residualRisks": [
    "Lifecycle/audio generation race",
    "Remote shell and SSH input validation gaps",
    "Directory replacement race",
    "Audio loss on bounded queue saturation",
    "Candidate effective-thinking callback loss",
    "Diagnostics ownership ambiguity"
  ],
  "noStagedFiles": true,
  "diffSummary": "No source changes; adversarial review only.",
  "reviewFindings": [
    "high: plan_v6 slices 1, 2, 5 - duplicated lifecycle-generation authority and incomplete cancellation ordering",
    "high: src/pi_client.rs:795-850 - environment-name and SSH-host validation are insufficient",
    "high: plan_v6 slice 3 - replacement-race rejection is asserted but not specified",
    "medium: plan_v6 slice 5 - bounded try_send queue-full behavior is undefined",
    "medium: plan_v6 slices 1-2 - Candidate startup callbacks can lose effective thinking",
    "medium: plan_v6 slices 1 and 8 - diagnostics ownership conflicts with process-global ring semantics"
  ],
  "manualNotes": "Review_v5 closure is substantial but not exact enough to approve."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 4m 30s (Total time 4m 30s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v7.md
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