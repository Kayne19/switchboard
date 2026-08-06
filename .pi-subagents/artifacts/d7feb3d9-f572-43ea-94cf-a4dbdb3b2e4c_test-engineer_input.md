# Task for test-engineer

Implement focused regression tests from the reviewed plan before/alongside the fix. Cover audio stream deduplication/lifecycle, skip-to-end advancing exactly once to the next item, stale/cancelled work not replaying the current item, runtime error paths, and model picker/catalog exposure including GPT 5.6, Luna, and Sol where the repository contract permits. Keep tests deterministic and follow docs/concurrency-and-test-hazards.md. Run the narrowest relevant checks. Only edit tests unless a tiny fixture is required.

## Context from phase 'plan_review'
# Handoff Output: plan_review
Status: success
Verdict: REVISE
Timestamp: 1785994118

## Content
# Findings

- **High:** `src/api.rs:727-773` and `extensions/agent-switchboard.ts:76-112` have no session token on `/speak`. A stale agent can POST after rescue, receive the new generation, and inject speech into the replacement leg. Generation-at-acceptance alone cannot prevent this.
- **High:** Planned stale transcript dropping leaves `web/app.ts:170-205` outbox entries pending forever. The browser removes clips only on history/transcript/error; no event means an accepted stale clip remains visible and is retransmitted indefinitely.
- **High:** New leg callbacks can be lost. `pbx.rs:613-641` starts the process before publishing its token to `LiveLegState`; `session_start` can report against the old token and is not retried. Also `api.rs:713-723` can publish an older accepted thinking value after a newer callback wins.
- **High:** A shared audio emission lock does not establish producer ordering. `process_speech` (`api.rs:280-290`) and final synthesis (`api.rs:858-881`) can synthesize concurrently; rescue can occur between stale-check and emission unless check-and-send is atomic. The plan needs an ordered enqueue/worker model, not merely a gate around `emit`.
- **High:** Native `<audio>` events carry no clip identity. An old `pause` after `ended` has the same target as the new clip, so token bookkeeping alone cannot distinguish it unless handlers/source transitions explicitly suppress stale events. Both event orders need deterministic guards.
- **Medium:** Recorder cleanup needs a terminal-once path if `onerror` occurs without `onstop`; otherwise “block until prior onstop” can permanently disable recording and leak tracks.
- **Medium:** New browser tests are not wired into `package.json:test` (currently only three existing scripts run), so the proposed regressions can silently remain unexecuted.
- **Medium:** Catalog failure/malformed output is currently collapsed into `entries: []` (`src/models.rs:297-370`). The plan says to distinguish states but does not define malformed-table detection or the browser contract/types for `models_available` and diagnostics.
- **Medium:** Stale STT/TTS work is suppressed only after completion; neither `process_clips` nor `process_speech` is registered for cancellation. Rescue can therefore retain sidecars/network work and emit stale errors.
- **Residual:** `accepted_clips` is a bounded 512-ID cache (`src/api.rs:1088-1130`), not durable replay prevention; an old retransmit after eviction can be logged again.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete race, stale-session, browser-contract, cancellation, catalog, and validation findings are listed with repository paths and line ranges."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Inspected the planned paths in src/api.rs, src/pbx.rs, src/models.rs, web/app.ts, extensions/agent-switchboard.ts, tests, and package.json."
  ],
  "residualRisks": [
    "Target-host model catalogs and canonical GPT 5.6/Luna/Sol IDs remain unverifiable from this repository."
  ],
  "noStagedFiles": true,
  "diffSummary": "Review only; no files changed.",
  "reviewFindings": [
    "high: /speak accepts stale-agent requests because it has no session token.",
    "high: dropped stale clips have no browser acknowledgement and remain in the outbox.",
    "high: leg-state startup and status-publication races remain unspecified.",
    "high: audio ordering and native playback event identity are not fully defined.",
    "medium: recorder terminal cleanup, test wiring, catalog state detection, and cancellation coverage are incomplete."
  ],
  "manualNotes": "Revise the plan to specify session validation, stale-clip acknowledgement, atomic leg-state publication, ordered audio queuing, robust playback suppression, and executable browser tests."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 28s (Total time 3m 27s · 1 turn)[0m

---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785993137994978505_3627287_0/tests.md
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