Findings

- Fixed high: `web/app.ts` no longer lets `pendingAttempt` suppress `ended`. A terminal event consumes the current owner even when `play()` is unresolved; stale promise settlement is ignored by the owner/token checks. The focused harness covers `pause -> ended` and `ended -> pause` with deferred promises.
- Fixed medium: the document click handler ignores clicks whose target is the media player, so native control clicks do not immediately call `play()` after a pause. The harness asserts native-target suppression and ordinary page-click resume.
- Fixed medium: terminal waiting now requires a recorded `seeking` event in addition to `currentTime >= duration`. Ordinary pauses at the final frame remain resumable. Reverse-seek/reset handling clears the marker.
- Fixed coverage gap: `tests/test_app.mjs` now defers play settlement across both terminal event orders, tests native-player click behavior, and retains lifecycle/error/stale-owner coverage.

Changed files: `web/app.ts`, `tests/test_app.mjs`, generated `static/app.js`.

Verification

- `npm run check` passed.
- `node tests/test_app.mjs` passed.
- `npm run build` passed.
- `npm test` passed all browser protocol, diagram, extension, and app tests.
- Rebuilding twice produced an identical `static/app.js` diff.
- `git diff --check` passed.
- No staged files are present.

Residual risk: no real-browser native media-control event run was available; the focused harness models the event target and deferred promise timing. Rust gates were not run because this change is browser-only and the prior environment reports `cargo` unavailable.