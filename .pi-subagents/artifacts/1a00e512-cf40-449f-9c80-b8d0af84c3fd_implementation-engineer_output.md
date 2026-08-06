Implemented the on-page model switcher.

Changed files:

- `src/pbx.rs`: expose cached project catalog entries in status, add `set_model`, preserve current requested thinking, and add catalog/swap regression tests.
- `src/api.rs`: add `POST /model` mirroring `/thinking`, returning `model_name`.
- `web/app.ts`, `web/browser.d.ts`, `web/protocol.ts`: add model select/fallback/disable behavior and surface successful JSON error payloads.
- `static/index.html`, generated `static/app.js`, `static/protocol.js`.
- `tests/test_protocol.mjs`.

Applied rulings R1, R2, R3, R5, and R6. R4 concurrency harness was intentionally skipped as directed. Empty-catalog model pass-through remains unchanged.

Checks:

- `cargo fmt --all -- --check`: passed
- `cargo check`: passed
- `cargo test --locked`: passed, 49 tests
- `cargo clippy --locked --all-targets -- -D warnings`: passed
- `npm run check`: passed
- `npm run build`: passed
- `npm test`: passed
- `python3 -m unittest discover -s legacy/tests`: passed, 143 tests
- `git diff --check`: passed
- `git diff --exit-code -- static`: nonzero because the intended generated static changes are present; build regeneration completed successfully.