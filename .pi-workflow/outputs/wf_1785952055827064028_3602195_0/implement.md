Implemented the on-page model switcher.

Changed files:

- `src/pbx.rs`: expose cached project catalog entries in status, add `set_model`, preserve current requested thinking, and add catalog/swap regression tests.
- `src/api.rs`: add `POST /model` mirroring `/thinking`, returning `model_name`.
- `web/app.ts`, `web/browser.d.ts`, `web/protocol.ts`: add model select/fallback/disable behavior and surface successful JSON error payloads.
- `static/index.html`, generated `static/app.js`, `static/protocol.js`.
- `tests/test_protocol.mjs`.

Applied rulings R1, R2, R3, R5, and R6. R4 concurrency harness was intentionally skipped as directed. Empty-catalog model pass-through remains unchanged.

Checks:

- `cargo fmt --all -- --check`: passed
- `cargo check`: passed
- `cargo test --locked`: passed, 49 tests
- `cargo clippy --locked --all-targets -- -D warnings`: passed
- `npm run check`: passed
- `npm run build`: passed
- `npm test`: passed
- `python3 -m unittest discover -s legacy/tests`: passed, 143 tests
- `git diff --check`: passed
- `git diff --exit-code -- static`: nonzero because the intended generated static changes are present; build regeneration completed successfully.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented the model catalog status payload, model mutation endpoint, browser control, fallback behavior, error handling, generated output, and regression tests in the listed files."
    }
  ],
  "changedFiles": [
    "src/pbx.rs",
    "src/api.rs",
    "web/app.ts",
    "web/browser.d.ts",
    "web/protocol.ts",
    "static/index.html",
    "static/app.js",
    "static/protocol.js",
    "tests/test_protocol.mjs"
  ],
  "testsAddedOrUpdated": [
    "src/pbx.rs",
    "src/api.rs",
    "tests/test_protocol.mjs"
  ],
  "commandsRun": [
    {"command":"cargo fmt --all -- --check","result":"passed","summary":"Formatting is clean."},
    {"command":"cargo check","result":"passed","summary":"Rust check passed."},
    {"command":"cargo test --locked","result":"passed","summary":"49 tests passed."},
    {"command":"cargo clippy --locked --all-targets -- -D warnings","result":"passed","summary":"Clippy passed with warnings denied."},
    {"command":"npm run check","result":"passed","summary":"TypeScript check passed."},
    {"command":"npm run build","result":"passed","summary":"Static browser output regenerated."},
    {"command":"npm test","result":"passed","summary":"All browser tests passed."},
    {"command":"python3 -m unittest discover -s legacy/tests","result":"passed","summary":"143 legacy tests passed."},
    {"command":"git diff --check","result":"passed","summary":"No whitespace errors."},
    {"command":"git diff --exit-code -- static","result":"failed","summary":"Expected nonzero while intended generated static files differ from the pre-change checkout."}
  ],
  "validationOutput": [
    "Cached catalog entries serialize as provider/model/thinks for the active project and [] on operator/cache misses.",
    "Model swaps preserve the current model_spec thinking suffix and refuse populated-catalog unknown models without replacing the live spec.",
    "The browser always injects the current model when absent from the catalog."
  ],
  "residualRisks": [
    "Catalog discovery failures intentionally leave only the current-model fallback; no alternatives are fabricated.",
    "The static diff check remains nonzero until these generated files are included in the resulting change set."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added the model switcher end to end, including cached catalog status, API operation semantics, browser control and generated assets.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "The project-leg concurrency harness was not added per ruling R4; the /model handler structurally mirrors /thinking."
}
```
