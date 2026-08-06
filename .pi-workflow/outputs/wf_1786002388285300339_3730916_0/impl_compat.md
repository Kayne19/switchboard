Implemented the remaining compatibility/documentation slice without editing `legacy/` or homelab.

Highlights:

- Unavailable model catalogs now pass through only provider-qualified specs and preserve normalized thinking suffixes; populated catalogs still enforce resolution/ambiguity rules.
- Candidate/project callback delivery now carries and validates the fresh per-process session token for speech/diagram callbacks. `delivered:false` is an extension tool error, preserving written fallback eligibility.
- Catalog snapshots remain usable for populated picker status, and failed picker requests restore the last committed native selection without overwriting newer status.
- Added callback-token, unavailable-catalog/suffix, picker restoration, and undelivered-speech regression coverage.
- Updated README, concurrency hazards, observability, and migration handoff docs for catalog fallback, callback identity, delivery ordering, speech fallback, logging/deadline contracts, and homelab boundary.
- Rebuilt committed `static/app.js` from web sources.

Checks:

- `cargo fmt --all` passed.
- `cargo test --locked` passed (69 tests).
- `cargo clippy --locked --all-targets -- -D warnings` passed.
- `npm test` passed.
- `python3 -m unittest discover -s legacy/tests` passed (143 tests).
- Documentation contract grep passed; `git diff --check` passed.
- Deterministic rebuild comparison passed. `git diff --exit-code -- static` is nonzero only because the intended static change is present relative to HEAD.
- No staged files; no legacy or homelab files changed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Provider-qualified unavailable-catalog passthrough, thinking suffix retention, callback delivery behavior, populated picker compatibility, race-safe picker restoration, documentation, and committed static output were implemented without editing legacy or homelab trees."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Rust tests (69), clippy, npm/browser and extension tests, legacy compatibility tests (143), deterministic static rebuild, documentation checks, and diff checks passed."
    }
  ],
  "changedFiles": [
    "README.md",
    "docs/concurrency-and-test-hazards.md",
    "docs/observability-and-coverage-handoff.md",
    "docs/rust-typescript-migration-handoff.md",
    "extensions/agent-switchboard.ts",
    "src/api.rs",
    "src/audio.rs",
    "src/diagnostic.rs",
    "src/lifecycle.rs",
    "src/main.rs",
    "src/models.rs",
    "src/pbx.rs",
    "src/pi_client.rs",
    "static/app.js",
    "tests/test_app.mjs",
    "tests/test_extensions.mjs",
    "web/app.ts"
  ],
  "testsAddedOrUpdated": [
    "src/models.rs",
    "src/lifecycle.rs",
    "tests/test_app.mjs",
    "tests/test_extensions.mjs"
  ],
  "commandsRun": [
    {
      "command": "cargo fmt --all",
      "result": "passed",
      "summary": "Rust formatting completed"
    },
    {
      "command": "cargo test --locked",
      "result": "passed",
      "summary": "69 Rust tests passed"
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "passed",
      "summary": "No warnings"
    },
    {
      "command": "npm test",
      "result": "passed",
      "summary": "TypeScript build and browser/extension suites passed"
    },
    {
      "command": "python3 -m unittest discover -s legacy/tests",
      "result": "passed",
      "summary": "143 legacy compatibility tests passed"
    },
    {
      "command": "deterministic npm build and cmp static/app.js",
      "result": "passed",
      "summary": "Committed static output matches rebuild"
    },
    {
      "command": "documentation contract grep",
      "result": "passed",
      "summary": "Deadline, stale-epoch, and successful tool-end documentation present"
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors"
    },
    {
      "command": "git diff --exit-code -- static",
      "result": "failed",
      "summary": "Expected nonzero because static/app.js is an intended worktree change relative to HEAD"
    }
  ],
  "validationOutput": [
    "Provider-qualified unavailable-catalog requests pass through with normalized suffixes; bare names remain rejected.",
    "Speech and diagram callback bodies include the fresh process token when configured; stale/candidate callback side effects fail closed.",
    "Picker operations restore the last server-confirmed value on failure and ignore late failures after status invalidation.",
    "Static browser output was deterministically rebuilt and compared byte-for-byte."
  ],
  "residualRisks": [
    "Deployment-host model catalogs, credentials, remote SSH behavior, and real browser/media timing remain environment-dependent.",
    "The static diff command remains nonzero until the intended worktree changes are committed by the parent workflow."
  ],
  "noStagedFiles": true,
  "diffSummary": "Completed model catalog passthrough/suffix compatibility, callback delivery identity/error semantics, populated picker status and picker rollback races, required docs, regression coverage, and static rebuild on top of delivery implementation.",
  "reviewFindings": [
    "No blockers found in focused Rust, Node, legacy, documentation, and static-output checks."
  ],
  "manualNotes": "Untracked .pi-subagents/ and .pi-workflow/ artifacts are pre-existing workflow files and were not touched; legacy and homelab boundaries were preserved."
}
```
