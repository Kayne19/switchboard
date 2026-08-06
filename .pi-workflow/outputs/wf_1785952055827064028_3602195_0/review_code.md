# Findings

1. **Blocker:** `src/models.rs:211-220`, `src/pbx.rs:1468-1475`, `src/pbx.rs:689-730`  
   When catalog discovery fails and `entries` is empty, `ModelCatalog::resolve()` accepts any `provider/model` string. The `/model` request reaches `redial()` and then `start_agent()` as `--model` without server-side catalog validation. Argument quoting prevents shell injection, but this remains unvalidated browser-controlled passthrough across the trust boundary. The added test only covers rejection with a populated catalog.

No concurrency/generation guard regression found: `/model` mirrors `/thinking` and uses cancellation, cleanup, reply delivery, and generation checks. `static/app.js` matches `web/app.ts`; reported builds and tests pass. No unrelated scope expansion observed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Implementation scope is narrow, but arbitrary provider/model values pass through when catalog discovery fails."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Diff tracing identified the exact validation bypass and confirmed concurrency, protocol, generated-output, and test behavior."
    }
  ],
  "changedFiles": [
    "src/api.rs",
    "src/pbx.rs",
    "static/app.js",
    "static/index.html",
    "static/protocol.js",
    "tests/test_protocol.mjs",
    "web/app.ts",
    "web/browser.d.ts",
    "web/protocol.ts"
  ],
  "testsAddedOrUpdated": [
    "src/pbx.rs",
    "src/api.rs",
    "tests/test_protocol.mjs"
  ],
  "commandsRun": [
    {
      "command": "cargo test --locked",
      "result": "passed",
      "summary": "49 tests passed."
    },
    {
      "command": "npm test",
      "result": "passed",
      "summary": "Browser protocol, diagram, and extension tests passed."
    },
    {
      "command": "npm run build",
      "result": "passed",
      "summary": "Generated static output is stable."
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "passed",
      "summary": "No clippy warnings."
    }
  ],
  "validationOutput": [
    "The model handler preserves /thinking cancellation and generation semantics.",
    "static/app.js is synchronized with web/app.ts.",
    "Status and protocol payload changes are additive."
  ],
  "residualRisks": [
    "Empty catalog permits arbitrary qualified model strings to reach the pi subprocess."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added model status/catalog exposure, API switching, browser controls, protocol error handling, and generated assets.",
  "reviewFindings": [
    "blocker: src/models.rs:211-220 - empty catalogs bypass model validation before subprocess launch"
  ],
  "manualNotes": "Shell quoting prevents command injection, but does not satisfy server-side model validation."
}
```

VERDICT: REQUEST_CHANGES

[38;2;136;136;136m✻ Turn took 2m 17s (Total time 2m 17s · 2 turns)[0m