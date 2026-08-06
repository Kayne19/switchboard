# Candidate/adoption and stale-work slice

Implemented the requested Rust slice without touching `legacy/` or homelab:

- Candidate startup now has coordinator-private staging, startup-thinking promotion, rollback, side-effect rejection, adoption failure cleanup, and extension stage rollback support.
- Callback thinking reports validate the current per-process leg token; candidate startup thinking remains private until adoption.
- Rescue, idle, shutdown, stale clip/turn/reply barriers, and stale-epoch browser acknowledgements are coordinated through the lifecycle generation.
- Same-session remote redial fails closed with `remote_shutdown_unverified` and returns to operator.
- SSH targets are centrally validated for model listing, remote Pi launch, prepare, and extension staging paths.
- Existing Pi JSONL and HTTP callback JSON shapes remain unchanged.

Changed files: `src/lifecycle.rs`, `src/api.rs`, `src/pbx.rs`, `src/pi_client.rs` (plus prior lifecycle wiring in `src/main.rs`).

Checks passed:

- `cargo fmt --all -- --check`
- `cargo test --locked` (63 tests)
- `cargo clippy --locked --all-targets -- -D warnings`
- `npm test`
- `git diff --check`

Residual risk: remote cleanup is best-effort and reports an unverified cleanup warning; remote shutdown cannot be verified by the current SSH/Pi protocol. Worktree has no staged files; pre-existing `.pi-workflow/` and `.pi-subagents/` artifacts remain untracked.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Rust-only lifecycle, candidate, stale-work, SSH validation, idle, shutdown, and redial changes; legacy and homelab trees were not edited."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "63 Rust tests, clippy, formatting, browser/npm tests, and diff checks pass; focused lifecycle, callback, stale-work, shutdown, remote-redial guard, and SSH validator coverage is present."
    }
  ],
  "changedFiles": [
    "src/lifecycle.rs",
    "src/api.rs",
    "src/pbx.rs",
    "src/pi_client.rs",
    "src/main.rs"
  ],
  "testsAddedOrUpdated": [
    "src/lifecycle.rs",
    "src/api.rs",
    "src/pi_client.rs"
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
      "summary": "63 tests passed"
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "passed",
      "summary": "No warnings"
    },
    {
      "command": "npm test",
      "result": "passed",
      "summary": "TypeScript build and browser/protocol/extension tests passed"
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors"
    }
  ],
  "validationOutput": [
    "Candidate side effects are rejected and startup thinking is promoted only on adoption.",
    "Stale clip and queued-turn work emits ID-bearing stale_epoch errors and is not persisted or dispatched.",
    "Shutdown and idle paths invalidate lifecycle generations before resource cleanup.",
    "Invalid SSH targets fail closed across remote argv and model-list paths; same-session remote redial returns remote_shutdown_unverified."
  ],
  "residualRisks": [
    "Remote cleanup and shutdown remain unverified by the existing SSH/Pi protocol; no speculative remote lock protocol was added.",
    "Full WebSocket delivery-state redesign and speech deadline contract remain outside this slice."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added coordinator-backed candidate adoption/rollback and callback privacy, stale-work barriers, idle/shutdown handling, fail-closed remote redial, and centralized SSH target validation with deterministic tests.",
  "reviewFindings": [
    "No blockers found in focused validation."
  ],
  "manualNotes": "Do not edit or stage pre-existing .pi-workflow/ or .pi-subagents/ runtime artifacts."
}
```
