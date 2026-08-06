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