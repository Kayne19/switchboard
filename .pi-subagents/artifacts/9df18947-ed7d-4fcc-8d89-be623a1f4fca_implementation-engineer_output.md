# Playback ownership fix

Implemented the shared playback lifecycle fix.

## Findings addressed

- **High, fixed:** `web/app.ts:374-544` now gives every clip an explicit playback owner with identity, consumed/requeued state, pending play-attempt token, pause/terminal-seek state, and retained handlers. Late events and promise settlements no-op when ownership changes.
- **Medium, fixed:** replacing or clearing an owner now detaches handlers, pauses, removes `src`, loads/unloads the player, and revokes the object URL before the next owner is installed.
- **Medium, fixed:** duplicate `ended`/`error` handling is guarded; consumed clips advance FIFO once. Pending `ended` events cannot immediately consume a newly installed owner during source handoff.
- **Medium, fixed:** repeated document clicks are blocked while a play attempt is pending. Rejected attempts tear down the owner before requeueing exactly once.
- **Medium, fixed:** terminal seek pauses wait for `ended`; reverse seeking and non-finite duration/current-time values reset the terminal guard without consuming on `timeupdate` alone.
- **Medium, fixed:** epoch rescue in `web/app.ts:856-860` reuses the shared cleanup helper.

## Changed files

- `web/app.ts`
- `tests/test_app.mjs`
- `static/app.js` (regenerated with the build)

## Validation

- `npm test` passed.
- `npm run check` passed.
- `git diff --check` passed.
- Generated `static/app.js` was rebuilt via `npm run build`.

Residual risk: native browser scheduling of `src` replacement, autoplay policy, and terminal seek event ordering still merits manual browser instrumentation.