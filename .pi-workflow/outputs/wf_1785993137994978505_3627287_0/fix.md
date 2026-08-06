# Review fixes

All five actionable findings are fixed at their shared state owners:

- **P1 recorder race, fixed:** `web/app.ts` now keeps chunks, discard state, stream cleanup, and stop/error handling in a per-recorder closure/object. A later recording cannot consume or discard an earlier recorder's data. Regression coverage defers `stop()` and overlaps two recorders in `tests/test_app.mjs`.
- **P1 playback race, fixed:** `web/app.ts` stamps each playback attempt with a generation and validates the blob before settling `play()`. Ended/pause/error handling rejects stale media state, and incoming clips no longer restart a paused current clip. Page clicks resume the retained blob. Browser-harness coverage exercises pause/resume and ordered advancement.
- **P1 catalog loading, fixed:** blank normal transfers now go through catalog resolution when model swaps are enabled, so `dial()` populates the project catalog before the first route status. `src/pbx.rs` regression asserts the catalog cache is populated.
- **P2 paused single clip, fixed:** the click handler resumes `currentBlob` directly; incoming audio queues behind a paused clip instead of restarting it.
- **P2 stale picker request, fixed:** per-control request generations invalidate late responses when `setRoute()` applies a new status. Late failures cannot overwrite status or re-enable a newly-disabled control. Regression coverage is in `tests/test_app.mjs`.

## Validation

- `npm test` passed, including the committed `static/app.js` rebuild and app regressions.
- `cargo test --locked` passed: 50 tests.
- `cargo fmt --all -- --check` passed.
- `cargo clippy --locked --all-targets -- -D warnings` passed.
- `python3 -m unittest discover -s legacy/tests` passed: 143 tests.
- `git diff --check` passed.

Residual risk: no real browser/media-device or WebSocket end-to-end run was available; media event ordering remains covered by the deterministic harness only.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Patched all five accepted findings at their shared recorder, playback, transfer catalog, and picker request state owners without caller-only guards."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Focused recorder, playback, picker, and catalog regressions pass along with the Rust, TypeScript, browser, and legacy test gates."
    }
  ],
  "changedFiles": [
    "web/app.ts",
    "static/app.js",
    "src/pbx.rs",
    "tests/test_app.mjs",
    "package.json"
  ],
  "testsAddedOrUpdated": [
    "tests/test_app.mjs",
    "src/pbx.rs"
  ],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "TypeScript build and all browser tests passed."
    },
    {
      "command": "cargo test --locked",
      "result": "passed",
      "summary": "50 Rust tests passed."
    },
    {
      "command": "cargo fmt --all -- --check",
      "result": "passed",
      "summary": "Formatting is clean."
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "passed",
      "summary": "Clippy passed with warnings denied."
    },
    {
      "command": "python3 -m unittest discover -s legacy/tests",
      "result": "passed",
      "summary": "143 compatibility tests passed."
    }
  ],
  "validationOutput": [
    "The generated static/app.js matches the web/app.ts build.",
    "git diff --check passed and no files are staged."
  ],
  "residualRisks": [
    "No real browser/media-device or WebSocket end-to-end validation was performed."
  ],
  "noStagedFiles": true,
  "diffSummary": "Per-operation recorder and playback ownership, initial transfer catalog loading, and picker request invalidation, with focused regressions and rebuilt browser output.",
  "reviewFindings": [
    "FIXED P1 web/app.ts recorder stop race through per-recorder chunks/discard state.",
    "FIXED P1 web/app.ts stale playback callbacks/events through generation and media-state guards.",
    "FIXED P1 src/pbx.rs blank transfers now load the model catalog.",
    "FIXED P2 web/app.ts paused single clips resume on page click and are not restarted by incoming audio.",
    "FIXED P2 web/app.ts stale picker requests cannot re-enable or overwrite newer route state."
  ],
  "manualNotes": "The worktree also contains pre-existing/unrelated untracked .pi-subagents and .pi-workflow artifacts; they were not modified or staged."
}
```
