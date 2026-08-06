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
