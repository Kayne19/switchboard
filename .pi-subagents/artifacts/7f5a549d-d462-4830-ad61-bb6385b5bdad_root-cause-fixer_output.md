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