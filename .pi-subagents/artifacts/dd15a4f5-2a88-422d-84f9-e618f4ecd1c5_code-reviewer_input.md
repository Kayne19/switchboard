# Task for code-reviewer

Review the implementation against the approved plan_v11 and repository instructions. Inspect the complete diff and tests, with special attention to lifecycle ownership, lock ordering/deadlocks, stale generation/turn epochs, candidate rollback, fail-closed SSH redial, callback/token safety, WebSocket wire compatibility, speech cancellation/fallback, diagnostics sanitization, model compatibility, legacy/static boundaries, and regressions. Do not edit files. Report findings ordered by severity with exact paths/lines and end exactly `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`.

## Context from phase 'impl_compat'
# Handoff Output: impl_compat
Status: success
Verdict: (none)
Timestamp: 1786012685

## Content
Implemented the remaining compatibility/documentation slice without editing `legacy/` or homelab.

Highlights:

- Unavailable model catalogs now pass through only provider-qualified specs and preserve normalized thinking suffixes; populated catalogs still enforce resolution/ambiguity rules.
- Candidate/project callback delivery now carries and validates the fresh per-process session token for speech/diagram callbacks. `delivered:false` is an extension tool error, preserving written fallback eligibility.
- Catalog snapshots remain usable for populated picker status, and failed picker requests restore the last committed native selection without overwriting newer status.
- Added callback-token, unavailable-catalog/suffix, picker restoration, and undelivered-speech regression coverage.
- Updated README, concurrency hazards, observability, and migration handoff docs for catalog fallback, callback identity, delivery ordering, speech fallback, logging/deadline contracts, and homelab boundary.
- Rebuilt committed `static/app.js` from web sources.

Checks:

- `cargo fmt --all` passed.
- `cargo test --locked` passed (69 tests).
- `cargo clippy --locked --all-targets -- -D warnings` passed.
- `npm test` passed.
- `python3 -m unittest discover -s legacy/tests` passed (143 tests).
- Documentation contract grep passed; `git diff --check` passed.
- Deterministic rebuild comparison passed. `git diff --exit-code -- static` is nonzero only because the intended static change is present relative to HEAD.
- No staged files; no legacy or homelab files changed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Provider-qualified unavailable-catalog passthrough, thinking suffix retention, callback delivery behavior, populated picker compatibility, race-safe picker restoration, documentation, and committed static output were implemented without editing legacy or homelab trees."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Rust tests (69), clippy, npm/browser and extension tests, legacy compatibility tests (143), deterministic static rebuild, documentation checks, and diff checks passed."
    }
  ],
  "changedFiles": [
    "README.md",
    "docs/concurrency-and-test-hazards.md",
    "docs/observability-and-coverage-handoff.md",
    "docs/rust-typescript-migration-handoff.md",
    "extensions/agent-switchboard.ts",
    "src/api.rs",
    "src/audio.rs",
    "src/diagnostic.rs",
    "src/lifecycle.rs",
    "src/main.rs",
    "src/models.rs",
    "src/pbx.rs",
    "src/pi_client.rs",
    "static/app.js",
    "tests/test_app.mjs",
    "tests/test_extensions.mjs",
    "web/app.ts"
  ],
  "testsAddedOrUpdated": [
    "src/models.rs",
    "src/lifecycle.rs",
    "tests/test_app.mjs",
    "tests/test_extensions.mjs"
  ],
  "commandsRun": [
    {
      "command": "cargo fmt --all",
      "result": "passed",
      "summary": "Rust formatting completed"
    },
    {
      "command": "cargo test --locked",
      "result": "passed",
      "summary": "69 Rust tests passed"
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "passed",
      "summary": "No warnings"
    },
    {
      "command": "npm test",
      "result": "passed",
      "summary": "TypeScript build and browser/extension suites passed"
    },
    {
      "command": "python3 -m unittest discover -s legacy/tests",
      "result": "passed",
      "summary": "143 legacy compatibility tests passed"
    },
    {
      "command": "deterministic npm build and cmp static/app.js",
      "result": "passed",
      "summary": "Committed static output matches rebuild"
    },
    {
      "command": "documentation contract grep",
      "result": "passed",
      "summary": "Deadline, stale-epoch, and successful tool-end documentation present"
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors"
    },
    {
      "command": "git diff --exit-code -- static",
      "result": "failed",
      "summary": "Expected nonzero because static/app.js is an intended worktree change relative to HEAD"
    }
  ],
  "validationOutput": [
    "Provider-qualified unavailable-catalog requests pass through with normalized suffixes; bare names remain rejected.",
    "Speech and diagram callback bodies include the fresh process token when configured; stale/candidate callback side effects fail closed.",
    "Picker operations restore the last server-confirmed value on failure and ignore late failures after status invalidation.",
    "Static browser output was deterministically rebuilt and compared byte-for-byte."
  ],
  "residualRisks": [
    "Deployment-host model catalogs, credentials, remote SSH behavior, and real browser/media timing remain environment-dependent.",
    "The static diff command remains nonzero until the intended worktree changes are committed by the parent workflow."
  ],
  "noStagedFiles": true,
  "diffSummary": "Completed model catalog passthrough/suffix compatibility, callback delivery identity/error semantics, populated picker status and picker rollback races, required docs, regression coverage, and static rebuild on top of delivery implementation.",
  "reviewFindings": [
    "No blockers found in focused Rust, Node, legacy, documentation, and static-output checks."
  ],
  "manualNotes": "Untracked .pi-subagents/ and .pi-workflow/ artifacts are pre-existing workflow files and were not touched; legacy and homelab boundaries were preserved."
}
```


---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/review_impl.md
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