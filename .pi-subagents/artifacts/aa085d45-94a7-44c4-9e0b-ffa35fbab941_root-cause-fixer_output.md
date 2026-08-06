# Repair findings

1. **Fixed:** `ModelCatalog` now distinguishes valid empty listings from unavailable/malformed listings, carries diagnostics, rejects explicit unverified provider/model swaps, and preserves configured startup fallback. PBX status exposes `models_available` and `models_diagnostic`; the picker disables unavailable model selection and shows the diagnostic.
2. **Fixed:** stale clip epochs are checked under the transition lock before transcript history or transcript events are written.
3. **Fixed:** audio synthesis reserves ordered sequence slots, emits generation/sequence metadata before binary audio, atomically rejects stale generations, clears pending server slots on rescue, and the browser drops queued/current old-epoch audio.
4. **Fixed:** project leg state callbacks carry `SWITCHBOARD_SESSION_TOKEN`; the server validates it against the live leg, including startup publication before the process is fully attached. Stale tokens are rejected.
5. **Fixed:** playback keeps the current blob across pause; ended advances even after pause, and ended-then-pause cannot re-wedge playback.
6. **Fixed:** recording refuses a new recorder while the prior recorder remains active, pending `onstop`, or permission startup; recorder errors without `onstop` release tracks and terminate ownership.
7. **Fixed:** route/model/thinking page operations share one serialized promise chain and retain request-generation/error/disabled-state protection.
8. **Fixed:** PBX catalog availability and diagnostic state are present in status responses.

## Changed files

`src/models.rs`, `src/api.rs`, `src/pbx.rs`, `extensions/agent-switchboard.ts`, `web/app.ts`, `web/browser.d.ts`, `static/app.js`, `tests/test_app.mjs` (plus the pre-existing worktree change in `package.json`).

## Tests and validation

Added/updated deterministic regressions for catalog state, stale transcript suppression, ordered audio slots, stale session tokens, pause/ended playback, recorder terminal cleanup, and picker serialization.

Commands passed:

- `cargo fmt --all -- --check`
- `cargo test --locked` (54 passed)
- `cargo clippy --locked --all-targets -- -D warnings`
- `npm test`
- `python3 -m unittest discover -s legacy/tests` (143 passed)
- `git diff --check`
- staged-file check: no staged files

Static output was rebuilt by `npm test` (`npm run build`).

## Residual risks

The extracted application is not deployed until the homelab deployment copy is switched to this tree/tag; that deployment-only drift remains outside this repository. No finding was deferred or blocked locally.