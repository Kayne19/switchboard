Implemented and validated:

- P1: blank transfers now load the catalog before route status publication while retaining configured fallback behavior.
- P2: added unavailable-catalog and serialized cross-control browser regressions.
- Fresh TypeScript build matches `static/app.js`.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Shared catalog loading fixed blank transfers without widening production scope."
    }
  ],
  "changedFiles": [
    "src/pbx.rs",
    "tests/test_app.mjs"
  ],
  "testsAddedOrUpdated": [
    "src/pbx.rs",
    "tests/test_app.mjs"
  ],
  "commandsRun": [
    {"command": "cargo test --locked", "result": "passed", "summary": "54 passed"},
    {"command": "npm test", "result": "passed", "summary": "All browser/protocol tests passed"},
    {"command": "cargo fmt --all -- --check", "result": "passed", "summary": "Clean"},
    {"command": "cargo clippy --locked --all-targets -- -D warnings", "result": "passed", "summary": "Clean"},
    {"command": "python3 -m unittest discover -s legacy/tests", "result": "passed", "summary": "143 passed"},
    {"command": "git diff --check", "result": "passed", "summary": "Clean"}
  ],
  "validationOutput": [
    "Fresh TypeScript build left static/app.js byte-identical.",
    "No staged files."
  ],
  "residualRisks": [
    "Browser regressions use deterministic Node harnesses rather than a real browser."
  ],
  "noStagedFiles": true,
  "diffSummary": "Blank transfers now populate model catalogs; browser tests cover unavailable catalogs and serialized route/model/thinking operations.",
  "reviewFindings": [
    "P1 fixed: blank project transfers load catalogs before status publication.",
    "P2 fixed: unavailable-catalog and cross-control serialization/error regressions added."
  ],
  "manualNotes": "Pre-existing unrelated worktree changes were preserved."
}
```

[38;2;136;136;136m✻ Turn took 5m 25s (Total time 5m 25s · 3 turns)[0m