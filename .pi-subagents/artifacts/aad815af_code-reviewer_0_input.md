# Task for code-reviewer

Read-only final audit of the CURRENT worktree, not historical workflow outputs. Inspect git diff and relevant callers/tests. Confirm specifically: (1) blank normal project transfers through dial/transfer/select_transfer_model load the catalog before status when swaps are enabled, (2) unavailable catalog UI state is tested and picker disables with diagnostics, (3) cross-control route/model/thinking operations are truly serialized and tested, and (4) the previously rejected seven findings remain fixed without regressions. Check that static/app.js matches web/app.ts. Run only focused read-only checks if useful. Report findings ordered by severity and end exactly with VERDICT: APPROVE or VERDICT: REQUEST_CHANGES. Do not edit files or commit.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files, validation-output, review-findings

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