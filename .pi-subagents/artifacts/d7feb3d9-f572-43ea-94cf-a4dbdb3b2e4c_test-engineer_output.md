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