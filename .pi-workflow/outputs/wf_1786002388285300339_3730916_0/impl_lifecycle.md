# Slice 1 implementation

Implemented the Rust lifecycle/coordinator seam and wired API generation/status reads through it without changing wire shapes.

- Added `src/lifecycle.rs` with `CallLifecycle`, `Coordinator`, `LegIdentity`, generation-aware `OperationIdentity`, phases, candidate startup state, immutable `StatusProjection`, and generation-matched `CatalogPublication`.
- Added short synchronous linearization methods for prompt begin/finish, steer attachment to the active prompt operation, callback acceptance, rescue generation advancement, candidate startup thinking/adoption, status publication, and shutdown.
- Replaced `AppInner`'s cached status/generation ownership with `Coordinator`; existing API stale-work checks and epoch snapshots now use coordinator generation.
- Added focused lifecycle tests for operation identity sharing, stale generations, candidate thinking privacy/adoption, catalog publication matching, rescue reopening, and status lock liveness.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Rust-only slice implemented in src/lifecycle.rs, src/api.rs, and src/main.rs; existing HTTP/WebSocket payload paths remain unchanged."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Focused lifecycle, stale-generation, catalog, operation, and status-lock tests pass, along with all existing Rust tests."
    }
  ],
  "changedFiles": [
    "src/lifecycle.rs",
    "src/api.rs",
    "src/main.rs"
  ],
  "testsAddedOrUpdated": [
    "src/lifecycle.rs (focused coordinator/status/lock tests)",
    "src/api.rs (generation test calls migrated to Coordinator)"
  ],
  "commandsRun": [
    {
      "command": "cargo fmt --all -- --check",
      "result": "passed",
      "summary": "Formatting clean"
    },
    {
      "command": "cargo test --locked",
      "result": "passed",
      "summary": "60 tests passed"
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "passed",
      "summary": "No warnings"
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors"
    }
  ],
  "validationOutput": [
    "Steer returns the same OperationIdentity as the active prompt operation.",
    "Rescue increments generation and stale operations/callbacks are rejected.",
    "Candidate startup thinking remains private until adoption.",
    "Catalog status is published only when project and generation match.",
    "Status reads do not wait on lifecycle linearization."
  ],
  "residualRisks": [
    "Switchboard still owns legacy route/session mirrors during this migration slice; later slices must complete ownership removal.",
    "The existing operation_transition and PBX/resource paths remain transitional and still need the planned full lock-order migration.",
    "No SSH, browser, TTS, or diagnostic-contract work was included in slice 1."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added coordinator lifecycle foundation and moved API status/generation reads and prompt/steer operation bookkeeping onto it.",
  "reviewFindings": [
    "No blockers found in focused Rust validation."
  ],
  "manualNotes": "Untracked .pi-workflow/.pi-subagents artifacts were pre-existing runtime outputs and were not edited or staged."
}
```
