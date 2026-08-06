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

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Fixed the shared playback ownership root cause in web/app.ts, regenerated static/app.js, and added focused deferred-promise, duplicate-event, retained-listener, cleanup, seek, and stale-settlement coverage in tests/test_app.mjs."
    }
  ],
  "changedFiles": [
    "web/app.ts",
    "tests/test_app.mjs",
    "static/app.js"
  ],
  "testsAddedOrUpdated": [
    "tests/test_app.mjs"
  ],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "All browser protocol, diagram, extension, app lifecycle, and model-picker tests passed."
    },
    {
      "command": "npm run check",
      "result": "passed",
      "summary": "TypeScript strict check passed."
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors."
    },
    {
      "command": "npm run build",
      "result": "passed",
      "summary": "Committed static browser output regenerated successfully."
    }
  ],
  "validationOutput": [
    "Playback tests model pause/load cleanup, deferred play promises, duplicate events, retained stale handlers, terminal seek reset, and stale rejected settlements.",
    "No deployment or homelab files were changed."
  ],
  "residualRisks": [
    "Native browser media event timing and autoplay behavior remain outside the Node harness and need manual browser instrumentation."
  ],
  "noStagedFiles": true,
  "diffSummary": "Replaced global blob/url playback state with explicit owner-scoped lifecycle and regenerated the browser bundle; expanded focused playback regression coverage.",
  "reviewFindings": [
    "fixed: web/app.ts:374-544 - global playback state allowed stale events and promises to mutate newer clips",
    "fixed: web/app.ts:380-392 - owner replacement now pauses, unloads, detaches, and revokes before source handoff",
    "fixed: web/app.ts:402-408 - duplicate or handoff ended events are owner/pending-attempt guarded",
    "fixed: web/app.ts:856-860 - epoch rescue now uses shared owner cleanup",
    "none remaining in the implemented scope"
  ],
  "manualNotes": "Browser instrumentation is still advisable for native src replacement, autoplay rejection, and seek-to-end event timing."
}
```
