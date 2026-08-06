Implemented the reviewed regression fixes.

- `web/app.ts`: retained the active clip separately through pause/ended transitions, preventing replay or duplicate queue advancement; added idempotent recorder stream release, recorder-error handling, and `start()` failure cleanup.
- `static/app.js`: regenerated from the TypeScript source.
- `package.json`: wired `tests/test_app.mjs` into `npm test`.
- `tests/test_app.mjs`: made the harness portable on Node 22 and kept coverage for playback, recorder lifecycle, duplicate starts, and catalog picker values.
- `src/models.rs`: retained the catalog regression coverage for GPT 5.6, Luna, Sol, and non-thinking validation.

Checks:

- `cargo fmt --all -- --check` passed
- `cargo test --locked` passed (50 tests)
- `cargo clippy --locked --all-targets -- -D warnings` passed
- `python3 -m unittest discover -s legacy/tests` passed (143 tests)
- `npm run check` passed
- `npm test` passed, including `tests/test_app.mjs`
- `git diff --check` passed
- `git diff --exit-code -- static` returned nonzero because the intended regenerated bundle changes are present; `npm run build` completed successfully.

No files are staged. Existing untracked `.pi-subagents/` and `.pi-workflow/` artifacts were not modified.