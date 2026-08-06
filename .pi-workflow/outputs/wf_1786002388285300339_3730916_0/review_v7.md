# Adversarial review

1. **High: lock replacement-race proof is still insufficient.**  
   `src/pi_client.rs` has no current lock implementation. The proposed `mkdirat` then `openat` sequence can accept a same-owner, same-mode directory substituted between those calls: `fstat` and `fstatat` then agree on the replacement. The stated checks and tests do not prove rejection. Use an atomic identity-preserving creation strategy or explicitly define the kernel-level invariant.

2. **High: host validation does not cover every SSH caller.**  
   Plan step 2 scopes validation to `remote_argv`, but `list_models_argv` at `src/pi_client.rs:753-766`, prepare at `src/pbx.rs:~605`, and extension staging at `src/pbx.rs:985-996` construct SSH commands separately. A leading-dash or control-character host can still reach those paths. Centralize validated SSH argument construction and test every caller.

3. **High: coordinator locking can regress nonblocking callbacks.**  
   `/speak`, `/leg-state`, and `/status` must remain live while the turn holds the PBX mutex (`src/api.rs:455-460`, tests around `1486-1525`). Plan step 1 does not define whether the new coordinator lock is independent, nor a global lock order between coordinator, lifecycle, and delivery locks. A naïve implementation deadlocks or blocks callbacks.

4. **High: candidate external side effects remain ungated.**  
   Private thinking staging only addresses `report_leg_state`. Candidate `speak` and `diagram` callbacks currently have external effects (`extensions/agent-switchboard.ts:99-106,192-200`; `src/api.rs:833-890,900-906`). The plan must reject or privately stage all candidate callbacks, including activity, speech, diagrams, and status publication, until adoption.

5. **High: redial/process settlement requirements are not explicit.**  
   Step 1 does not require the old same-session process to be fully closed and reaped before starting a candidate, nor specify lock-invalid/exit-75 settlement back to operator. “Transfer/redial” inclusion alone does not prevent partial route/model/session publication on startup failure (`src/pbx.rs:~1170-1264`).

6. **Medium: socket epoch ownership and reconnect cleanup are only asserted.**  
   The existing broadcast path has no exact-connection `try_send` (`src/api.rs:1030-1080,1261-1280`). The plan names connection identities but omits epoch allocation, replacement cleanup, disconnect cancellation, lag handling, and snapshot ordering. Without those mechanics, a reservation can target a replaced socket or remain pending.

7. **Medium: speech timeout/cancellation remains underspecified.**  
   `extensions/agent-switchboard.ts:99-106` times out at 30 seconds, while TTS also has bounded transport behavior. Plan step 4 says “timeout” but gives no shared deadline, cancellation propagation, or late-result rule, so a timed-out tool can still deliver audio and trigger fallback/duplicate speech.

8. **Medium: successful tool completion correlation is missing.**  
   `Turn::agent_spoke()` currently treats `tool_execution_start` as speech (`src/pi_client.rs:54-56,414-435`). Plan step 4 does not require correlating `toolCallId` with successful completion. A failed `/speak` can therefore suppress ordinary fallback speech, breaking prior RPC behavior.

9. **Medium: fresh status projection and catalog compatibility are not carried forward.**  
   `status_snapshot` remains a second mutable status authority (`src/api.rs:37,176-204,302-315`), but plan step 1 only says “publish” status. Also, unavailable catalogs currently reject provider-qualified passthrough in `src/models.rs:230-237`; the plan merely says preserve it and adds no implementation or regression test.

Residual risks: lifecycle deadlock, same-owner lock aliasing, stale/replaced socket delivery, candidate side effects, duplicate speech, redial partial state, and compatibility regressions.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Plan_v7 closes the six review_v6 topics at a high level, but does not concretely preserve all earlier lock, callback, redial, socket, speech, status, and compatibility invariants."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository and plan inspection",
      "result": "passed",
      "summary": "Inspected lifecycle, API, SSH, extension, model, browser, and concurrency paths."
    }
  ],
  "validationOutput": [
    "Found nine unresolved or insufficiently specified risks, including three high-severity security/lifecycle gaps."
  ],
  "residualRisks": [
    "Replacement-race acceptance in descriptor traversal",
    "Unvalidated SSH callers",
    "Coordinator lock blocking callbacks",
    "Candidate speech/diagram side effects",
    "Incomplete redial settlement",
    "Socket epoch replacement races",
    "TTS timeout duplicate delivery",
    "Missing tool completion correlation",
    "Stale status and unavailable-catalog compatibility"
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only adversarial review; no source changes.",
  "reviewFindings": [
    "high: src/pi_client.rs and plan step 3 - same-owner replacement can still be accepted",
    "high: src/pi_client.rs:753-766 and src/pbx.rs:985-996 - SSH host validation bypasses remain",
    "high: src/api.rs:455-460 - coordinator lock order/nonblocking behavior is unspecified",
    "high: extensions/agent-switchboard.ts:99-106,192-200 - candidate external callbacks remain ungated",
    "high: src/pbx.rs:~1170-1264 - close/reap and exit-75 redial settlement are not explicit",
    "medium: src/api.rs:1030-1080,1261-1280 - socket epoch lifecycle is asserted, not specified",
    "medium: extensions/agent-switchboard.ts:99-106 - timeout cancellation and late results are undefined",
    "medium: src/pi_client.rs:54-56,414-435 - tool completion correlation is omitted",
    "medium: src/api.rs:37,176-204 and src/models.rs:230-237 - status/catalog compatibility is not concretely preserved"
  ],
  "manualNotes": "The six review_v6 headings are named in plan_v7, but exact closure and preservation of earlier requirements cannot be confirmed."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 48s (Total time 3m 48s · 1 turn)[0m