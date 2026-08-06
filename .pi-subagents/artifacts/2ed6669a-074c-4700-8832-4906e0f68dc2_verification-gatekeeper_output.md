# Final verification

## Findings

- No correctness regressions found in the reviewed diff (`web/app.ts`, `tests/test_app.mjs`, `static/app.js`).
- Generated output is synchronized: rebuilding left `static/app.js` byte-identical (SHA-256 `85dab19d04350b01985b9298cb1c6845f20eb3d36a826d7714a05d9413c9a451`).
- No staged files. The only tracked changes are the three expected files; `.pi-subagents/` and `.pi-workflow/` are untracked workflow artifacts.

## Commands and results

- `npm run check` -> exit 0; TypeScript check passed.
- `node tests/test_app.mjs` -> exit 0; lifecycle, ordering, race, seek, and native-click regressions passed.
- `npm run build` -> exit 0; bundle rebuilt.
- `npm test` -> exit 0; protocol, diagram, extensions, and app suites passed.
- `python3 -m unittest discover -s legacy/tests` -> exit 0; 143 tests passed. Expected simulated error logs were emitted by tests.
- `git diff --check` -> exit 0; no whitespace errors.
- Deterministic rebuild (`npm run build` plus SHA-256 comparison) -> exit 0; before/after hashes identical.
- `cargo fmt --all -- --check` -> exit 127; `cargo: command not found`.
- `cargo test --locked` -> exit 127; `cargo: command not found`.
- `cargo clippy --locked --all-targets -- -D warnings` -> exit 127; `cargo: command not found`.
- `git diff --exit-code -- static` -> exit 1; expected because the intended generated bundle is uncommitted relative to `HEAD`; deterministic rebuild verification passed.

## Residual risks

- Native media-control timing was modeled by the focused Node harness, not exercised in a real browser.
- Rust gates remain unavailable because `cargo` is not installed; no Rust files changed.

PASS for the browser change and all available relevant gates. Rust verification is unavailable, not passed.