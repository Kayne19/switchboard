Findings:

1. **P1** `src/pbx.rs:1149-1159,1463-1468`: normal blank transfers skip catalog loading. `status()` then reports `models_available: false`, and `web/app.ts:548-557` disables the model picker. Alternate models are inaccessible on the normal first project connection.
2. **P2** `tests/test_app.mjs:321-393,409-450`: tests cover populated catalogs and stale picker errors, but not unavailable-catalog UI state or two concurrent picker operations. The claimed race coverage is incomplete.

The other seven repair areas are implemented with corresponding Rust/browser regressions. Reported full test suites passed, and fresh TypeScript output matches `static/app.js`; the expected static git-diff failure remains because the generated file is intentionally modified. Deployment-host availability remains externally unverified.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete unresolved catalog-loading and test-coverage findings are reported with file and line references."
    }
  ],
  "changedFiles": [
    "src/models.rs",
    "src/api.rs",
    "src/pbx.rs",
    "web/app.ts",
    "web/browser.d.ts",
    "static/app.js",
    "extensions/agent-switchboard.ts",
    "tests/test_app.mjs",
    "package.json"
  ],
  "testsAddedOrUpdated": [
    "src/models.rs",
    "src/api.rs",
    "src/pbx.rs",
    "tests/test_app.mjs"
  ],
  "commandsRun": [
    {"command":"cargo test --locked","result":"passed","summary":"54 passed"},
    {"command":"cargo clippy --locked --all-targets -- -D warnings","result":"passed","summary":"clean"},
    {"command":"npm test","result":"passed","summary":"browser tests passed"},
    {"command":"npx tsc --project tsconfig.json --outDir <temporary> && cmp static/app.js","result":"passed","summary":"generated output matches source"},
    {"command":"python3 -m unittest discover -s legacy/tests","result":"passed","summary":"143 passed"},
    {"command":"git diff --exit-code -- static","result":"failed","summary":"expected intended static change"}
  ],
  "validationOutput": [
    "Stale transcript, ordered audio, token, playback, recorder, and picker-state implementations were inspected.",
    "Local pi catalog was available; deployment-host catalogs and credentials remain unverified."
  ],
  "residualRisks": [
    "Normal initial project connections leave the picker disabled until another path loads a catalog.",
    "No real browser/media-device or remote deployment validation was performed."
  ],
  "noStagedFiles": true,
  "diffSummary": "Repair implements the eight requested areas but leaves lazy initial catalog loading and incomplete picker race/state tests.",
  "reviewFindings": [
    "P1: src/pbx.rs:1149-1159,1463-1468 - blank transfers skip catalog loading, leaving the normal picker disabled via src/pbx.rs:300-333 and web/app.ts:548-557.",
    "P2: tests/test_app.mjs:321-393,409-450 - unavailable-catalog and concurrent cross-control serialization regressions are not tested."
  ],
  "manualNotes": "No files were edited."
}
```
VERDICT: REQUEST_CHANGES

[38;2;136;136;136m✻ Turn took 4m 18s (Total time 4m 17s · 2 turns)[0m