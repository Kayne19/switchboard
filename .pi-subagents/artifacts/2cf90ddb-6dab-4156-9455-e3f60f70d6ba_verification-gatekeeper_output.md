# Verification findings

No playback blockers found in the implemented scope. `web/app.ts` has one `player.play()` call and one owner-scoped `ended` registration; the old global playback variables/handler path are absent. The focused harness passed assertions for source cleanup, FIFO advancement, duplicate events, stale handlers/settlements, autoplay requeue, and terminal seek without click-resume.

The generated bundle is deterministic: two consecutive builds produced SHA-256 `4fc00a7d0d5beb70792e131f9f6e91bad46a44cb6e014340ee0b0ef21b451e26`. The literal CI command `git diff --exit-code -- static/app.js` returned exit 1 because `static/app.js` is intentionally one of the changed generated files; this is not a stale-output indication. The repeated-build check passed.

Commands and results:

- `npm run check` -> exit 0, TypeScript strict check passed.
- `npm test` -> exit 0, build plus protocol, diagram, extension, and app tests passed.
- `node tests/test_app.mjs` -> exit 0, focused playback/app regressions passed.
- `git diff --check` -> exit 0, no whitespace errors.
- `npm run build` twice with SHA-256 comparison -> exit 0, output stable.
- `python3 -m unittest discover -s legacy/tests` -> exit 0, 143 tests passed (expected simulated-error tracebacks were emitted).
- `cargo fmt --all -- --check` -> exit 127, unavailable: `cargo: command not found`.
- `cargo test --locked` -> exit 127, unavailable: `cargo: command not found`.
- `cargo clippy --locked --all-targets -- -D warnings` -> exit 127, unavailable: `cargo: command not found`.
- `git diff --exit-code -- static/app.js` -> exit 1, intentional generated diff as described above.

Residual risk: native browser media scheduling, autoplay policy, and terminal-seek event ordering remain outside the Node harness. Rust gates could not be verified in this environment. The worktree has no staged files; the only tracked changes are `web/app.ts`, `tests/test_app.mjs`, and regenerated `static/app.js`. Runtime `.pi-subagents/` and `.pi-workflow/` directories are untracked and unrelated.