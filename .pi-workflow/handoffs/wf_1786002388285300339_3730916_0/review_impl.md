# Handoff Output: review_impl
Status: success
Verdict: REQUEST_CHANGES
Timestamp: 1786012946

## Content
Findings, ordered by severity:

1. **Blocker:** `/speak` reports success before TTS or WebSocket delivery. `src/api.rs:1045-1099` returns `delivered:true` merely when a browser is connected and queues work; `process_speech` later reports TTS failures (`src/api.rs:482-519`). The extension then suppresses written fallback after a false success.

2. **High:** Redial bypasses coordinator adoption. `src/pbx.rs:1340-1433` generates a new callback token but never updates `Coordinator`; new callbacks are rejected while delayed callbacks bearing the old token remain accepted.

3. **High:** Rescue can race turn registration. `src/api.rs:687-731,780-809,438-451` checks generation and begins the operation before registering its abort handle. Rescue can clear the registry in between, allowing stale `board.handle()` work to execute after rescue.

4. **High:** Candidate lifecycle is not transactional. `src/pbx.rs:694` drops the existing leg before candidate startup, contrary to deferred cleanup. `ExtensionStageTxn::commit` is never used; staging is cached immediately via `src/pbx.rs:1065-1090`, so failed candidates can remove shared artifacts.

5. **High:** Callback acceptance does not require an active operation. `src/lifecycle.rs:483-502` validates only token and phase; `/speak` and `/diagram` (`src/api.rs:1019,1099`) can accept late callbacks after a turn settles.

6. **Medium:** Invalid candidate startup thinking is accepted and promoted publicly. `src/lifecycle.rs:504-544` stores candidate values before validating `THINKING_LEVELS`.

7. **Medium:** Diagnostics log unbounded sensitive context: complete argv/system prompts (`src/pi_client.rs:133`), raw prepare stderr (`src/pbx.rs:1038-1046`), and model-listing commands (`src/models.rs:339-365`), contrary to the sanitization boundary.

8. **Medium:** Invalid `SWITCHBOARD_SPEECH_DEADLINE_MS` silently falls back rather than being rejected (`src/main.rs:155-162`, `src/audio.rs:23-36`).

No files were edited. Tests were not rerun in this review.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete implementation findings are listed with severity and exact source paths/ranges."
    }
  ],
  "changedFiles": [
    "README.md",
    "extensions/agent-switchboard.ts",
    "src/api.rs",
    "src/audio.rs",
    "src/diagnostic.rs",
    "src/lifecycle.rs",
    "src/main.rs",
    "src/models.rs",
    "src/pbx.rs",
    "src/pi_client.rs",
    "tests/test_app.mjs",
    "tests/test_extensions.mjs",
    "web/app.ts",
    "static/app.js"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Reviewed lifecycle, callback, redial, staging, delivery, browser, diagnostics, model, and SSH paths."
  ],
  "residualRisks": [
    "Repository test claims from implementation handoffs were not independently rerun."
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only adversarial review of the implementation against plan_v11.",
  "reviewFindings": [
    "blocker: /speak reports delivery before TTS and writer commitment.",
    "high: redial token ownership bypasses Coordinator.",
    "high: stale turn registration can execute after rescue.",
    "high: candidate staging and adoption are not transactional.",
    "high: callbacks are accepted without an active operation.",
    "medium: invalid startup thinking is promoted.",
    "medium: diagnostics expose prompts, commands, and stderr.",
    "medium: invalid speech deadlines silently default."
  ],
  "manualNotes": "No source files were edited."
}
```

VERDICT: REQUEST_CHANGES

[38;2;136;136;136m✻ Turn took 4m 16s (Total time 4m 15s · 2 turns)[0m