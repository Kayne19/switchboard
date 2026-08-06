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