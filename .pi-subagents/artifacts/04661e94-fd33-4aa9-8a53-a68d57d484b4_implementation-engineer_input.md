# Task for implementation-engineer

Implement the reviewed plan and make the regression tests pass. Fix root causes in shared audio/turn lifecycle and skip transition code, preserve cancellation/epoch guarantees, avoid duplicate audio streams, and correct the model picker/catalog contract. Ensure requested GPT 5.6, Luna, and Sol are shown when available from the authoritative catalog, without inventing deployment models if they are external configuration. Run targeted Rust/browser/legacy checks as appropriate. Do not make unrelated refactors.

## Context from phase 'tests'
# Handoff Output: tests
Status: success
Verdict: (none)
Timestamp: 1785994468

## Content
# Regression tests added

- `tests/test_app.mjs`: dependency-free TypeScript extraction harness for browser runtime behavior.
  - Ensures concurrent recording starts make one `getUserMedia` request/recorder.
  - Verifies discard, constructor failure, permission failure, and recorder-error microphone cleanup.
  - Reproduces `pause` followed by `ended` when skipping audio to the end and asserts exactly one advance to the next clip; also guards stale pause and queue state.
  - Verifies model-picker catalog values expose `openai/gpt-5.6`, `moonshot/luna`, and `openai/sol`.
- `src/models.rs` test module: catalog parsing/resolution test for GPT 5.6, Luna, and Sol, including thinking validation for a non-thinking model.

## Checks

- `npm run check` passed.
- `cargo test models::tests::catalog_exposes_provider_models_with_decimal_and_short_names` passed.
- `node tests/test_app.mjs` currently fails at the intended playback regression: existing `pause`-then-`ended` handling replays the first clip instead of advancing to the second. The later recorder-error assertion will exercise the reviewed terminal-cleanup fix once playback is fixed.

## Residual risks

- The new browser test is not yet included in `package.json`'s existing `npm test` command; wire it when integrating the production fix.
- No real browser/device or native WebSocket client is used. Server-side bounded-ID deduplication remains covered only by existing implementation paths, not an end-to-end socket test.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Added deterministic regression tests for browser audio lifecycle, exactly-once skip advancement, stale pause suppression, runtime recorder errors, and dynamic model catalog/picker exposure in tests/test_app.mjs and src/models.rs test module."
    }
  ],
  "changedFiles": [
    "tests/test_app.mjs",
    "src/models.rs"
  ],
  "testsAddedOrUpdated": [
    "tests/test_app.mjs",
    "src/models.rs::catalog_exposes_provider_models_with_decimal_and_short_names"
  ],
  "commandsRun": [
    {
      "command": "npm run check",
      "result": "passed",
      "summary": "TypeScript type-check passed"
    },
    {
      "command": "cargo test models::tests::catalog_exposes_provider_models_with_decimal_and_short_names",
      "result": "passed",
      "summary": "Focused catalog regression passed"
    },
    {
      "command": "node tests/test_app.mjs",
      "result": "failed",
      "summary": "Expected red test: current pause-before-ended implementation replays the first clip"
    }
  ],
  "validationOutput": [
    "The browser test fails at the known skip-to-end regression before the fix, rather than passing vacuously."
  ],
  "residualRisks": [
    "tests/test_app.mjs needs to be wired into npm test",
    "No real browser/device or WebSocket end-to-end test"
  ],
  "noStagedFiles": true,
  "diffSummary": "Added focused browser runtime regression harness and dynamic model catalog coverage; no production logic changed.",
  "reviewFindings": [
    "high: web/app.ts playback pause-before-ended ordering currently requeues the finished clip and replays it instead of advancing exactly once",
    "medium: recorder onerror terminal cleanup is not yet exercised to green because the current implementation has no handler",
    "medium: the new browser test is not wired into package.json npm test"
  ],
  "manualNotes": "The app test is intentionally red until the paired playback and recorder lifecycle fixes land; type-check and focused Rust catalog coverage are green."
}
```


---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785993137994978505_3627287_0/implement.md
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