# Handoff Output: plan
Status: success
Verdict: (none)
Timestamp: 1785952421

## Content
# Minimal implementation plan

1. **Expose the cached catalog and add the PBX mutator**
   - `src/pbx.rs:Switchboard::status`: add `models` containing current-project cached `ModelCatalog.entries`, serialized as `{provider, model, thinks}`. Use `[]` for operator/cache misses; no `src/models.rs` changes.
   - `src/pbx.rs:Switchboard::set_model`: reject operator changes, otherwise call `redial(model, "", "", true)`. This preserves context, current thinking, `model_swaps`, `resolve()`, and `ModelError` behavior.

2. **Mirror `/thinking` at the API layer**
   - `src/api.rs:AppState::router`: register `POST /model`.
   - Add `Model { model: String }` and `model()` beside `thinking()`.
   - Use the same active-vs-replacing operation branch, cancellation responses, `clear_active_operation`, `deliver_page_reply_if_current`, and generation guard.
   - Request: `{ "model": "provider/model" }`.
   - Success: HTTP 200, `{ "model": "provider/model", "error": null }`; PBX validation failures remain HTTP 200 with the error string, matching `/thinking`.
   - Cancellation/supersession remain HTTP 409; task failures remain HTTP 500.

3. **Add the browser control and types**
   - `static/index.html`: add `#modelSelect` in `#legControls`, before `#thinkingSelect`, with a model-specific `title`.
   - `web/browser.d.ts`: type `models` as catalog entries.
   - `web/app.ts`: bind `modelSelect`; populate it in `setRoute()` through existing `fillSelect()`, using `provider/model` values and `msg.model_name` as current selection.
   - Add a current-model fallback option when the catalog is empty, without inventing alternatives.
   - Disable with `!onProject || msg.model_swaps === false`; the operator remains non-swappable.

4. **Reuse existing POST/error behavior**
   - `web/app.ts`: add the model change listener and call `post("/model", { model }, modelSelect)`.
   - `web/protocol.ts`: have existing `postJson()` return the successful JSON payload; have existing `post()` treat a non-null response `error` as an exception. This surfaces `ModelError` while retaining the endpoint’s existing 200-plus-error contract and also improves `/thinking`.
   - Update `tests/test_protocol.mjs`’s fetch stub for JSON responses and verify successful error payloads reject.

5. **Tests and generated output**
   - Extend Rust tests in `src/pbx.rs` and `src/api.rs` for catalog serialization, invalid-model refusal without replacing the live spec, request/response shape, and operation behavior.
   - Run the TypeScript build; commit generated `static/app.js`. Do not hand-edit it.

### Verification

```text
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm run check
npm test
git diff --exit-code -- static
```

### Rejected alternatives and risks

- Rejected a `/models` polling endpoint: status/WebSocket already carries the required payload.
- Rejected a second resolver or dependency: `ModelCatalog::resolve()` and `redial()` are the authoritative path.
- Rejected HTTP 400 for PBX model errors because it would diverge from `/thinking`.
- Catalog fetch failure leaves only the current-model fallback; alternatives cannot be safely fabricated.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The plan confines implementation to the existing PBX/API/status/browser paths, with only narrow protocol typing and generated-output updates required for error surfacing and the committed build."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Exact symbols, endpoint shapes, concurrency semantics, validation path, verification commands, rejected alternatives, and residual risks are specified."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Repository map and relevant Rust, TypeScript, HTML, test, and README paths inspected.",
    "No code was written because this deliverable is plan-only."
  ],
  "residualRisks": [
    "Catalog listing failures provide no alternative model choices beyond the current-model fallback."
  ],
  "noStagedFiles": true,
  "diffSummary": "No implementation changes; produced the minimal implementation plan.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Implementation should regenerate static/app.js and verify the full command list."
}
```

[38;2;136;136;136m✻ Turn took 3m 18s (Total time 3m 17s · 1 turn)[0m