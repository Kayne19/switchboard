# Task for root-cause-fixer

The previous final review rejected the current uncommitted implementation. Patch every actionable finding below at the shared state owner, add deterministic regressions, and rebuild static output when web/app.ts changes. Do not merely document or defer these issues.

Findings:
1. src/models.rs:211-221,297-370 collapses unavailable/malformed catalogs into empty catalogs and accepts arbitrary qualified provider/model strings. Distinguish unavailable/malformed from valid empty catalogs; preserve configured startup fallback but reject explicit unverified swaps; expose models_available and a diagnostic state to the picker.
2. src/api.rs:344-374 persists/broadcasts transcripts before checking clip epoch. Suppress stale transcript history/events before persistence.
3. src/api.rs:57-59,272-290,853-881 emits audio without generation/order metadata; producers can complete out of order and stale queued audio survives rescue. Add an ordered enqueue/emission design with atomic stale checks and clear/drop stale browser audio on epoch changes.
4. src/pbx.rs:54-104,1068, extensions/agent-switchboard.ts:44-50, src/api.rs:709-716 lack session identity for leg-state callbacks. Include/validate session token and reject stale callbacks, including startup publication races.
5. web/app.ts:407-430 can set isPlaying false on pause and reject subsequent ended, leaving playback stuck. Fix the state machine and test pause-then-ended and ended-then-pause without artificial clicks.
6. web/app.ts:835-967 still allows overlapping microphone streams before prior recorder onstop cleanup. Block new recording until terminal cleanup, including onerror-without-onstop paths.
7. web/app.ts:489-565 only has per-control request generations; route/model/thinking operations can overlap and conflict. Serialize shared page-control operations and preserve disabled/error state.
8. src/pbx.rs:289-316 does not expose catalog availability/diagnostics, making unavailable and valid-empty indistinguishable.

Use the existing current diff and repository instructions. Run focused checks, then report changed files, tests, residual deployment-only risks, and any finding that truly cannot be fixed locally.

---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785995920184813107_3673414_0/repair.md
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