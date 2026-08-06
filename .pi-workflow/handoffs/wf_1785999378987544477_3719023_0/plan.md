# Handoff Output: plan
Status: success
Verdict: (none)
Timestamp: 1785999780

## Content
# Playback ownership fix plan

## Findings

- **High:** `web/app.ts:368-454` (`playNext`, `ended`, `pause`, `error`, document-click handlers) has no per-clip event identity or consumed latch. Late and duplicate events can mutate a newer clip.
- **Medium:** `web/app.ts:370-386` replaces `player.src` without explicitly pausing and unloading the prior owner.
- **Medium:** `web/app.ts:437-454` can resume a seek-to-end pause before `ended` confirms completion.
- **Medium:** `tests/test_app.mjs:31-116` lacks reverse event ordering, duplicate events, stale play rejection, and owner-cleanup coverage.
- `static/index.html:711` has only one native player; no server change is justified.

## Ordered implementation

1. **Make ownership explicit in `web/app.ts`.** Replace the ambiguous `currentBlob/currentUrl` pairing with one active playback-owner record containing the blob, URL, unique token, consumed state, pending-play token, and seek-to-end confirmation state. Update binary-frame and epoch-rescue references accordingly.
2. **Centralize lifecycle transitions around `playNext` and new local helpers.**
   - Keep ordinary pause ownership and queue membership unchanged.
   - Before replacing or clearing an owner, invalidate it, detach its media handlers, call `player.pause()`, remove `src`, call `player.load()`, and revoke its object URL.
   - Assign a fresh owner token and install media handlers that close over that owner. Old callbacks must no-op when their owner is no longer active.
   - Increment the play-attempt token for every `play()` call, including resume, so stale promise settlements cannot restore playback.
3. **Make event handling idempotent.**
   - `pause` only marks the active owner paused and invalidates pending continuation; it never consumes or requeues the blob.
   - Detect a pause at the clip duration as awaiting end confirmation; document-click resume must not restart it before `ended`.
   - `ended` and decode `error` call one guarded consume/advance helper. The helper marks consumed before cleanup, so either event order and duplicates advance FIFO once.
   - A rejected `play()` requeues the owner once only while its owner and attempt tokens remain current.
4. **Reuse the same cleanup helper in the epoch-rescue block at `web/app.ts:768-780`.** Preserve queue clearing and epoch invalidation, but do not duplicate player pause/source/URL cleanup. Do not modify `src/api.rs`, `static/index.html`, or server delivery.
5. **Extend `tests/test_app.mjs:31-116`.** Upgrade the fake player to model `pause`, `load`, `paused`, duration/currentTime, errors, deferred play promises, and multiple listeners. Cover:
   - ordinary pause retains A and queued B; resume starts A once;
   - `pause → ended` and `ended → pause`;
   - duplicate ended/pause/error events;
   - stale A handlers and rejected A promises after B starts;
   - explicit pause/load cleanup and one owner/source at a time.
6. **Regenerate `static/app.js` only through `npm run build`; never hand-edit generated output.**

## Checks

- `npm test`
- `npm run check`
- `git diff --check`
- `git diff --exit-code -- static` after the build, confirming generated output is included and stable.
- Manual browser instrumentation should log `src`, `play`, `pause`, `load`, URL revocation, and every media owner during both seek event orders.

## Rejected alternatives

- No caller-specific guards: the shared playback lifecycle is the root cause.
- No server/API changes: delivery is already ordered and the defect is browser ownership/state.
- No second audio element or new playback abstraction: one native player exists; explicit owner identity and cleanup are sufficient.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The plan identifies severity-rated findings in web/app.ts and tests/test_app.mjs, names exact symbols, specifies the minimal ownership/idempotence fix, and defines runnable checks."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Inspected web/app.ts, static/app.js, static/index.html, tests/test_app.mjs, package.json, tsconfig.json, and docs/concurrency-and-test-hazards.md.",
    "Confirmed one native audio element and no server-side evidence requiring a change."
  ],
  "residualRisks": [
    "Static inspection cannot prove whether the reported second stream is a browser source-replacement artifact or another runtime owner.",
    "Browser-specific media event timing still requires manual instrumentation after implementation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; implementation plan only.",
  "reviewFindings": [
    "high: web/app.ts:368-454 - playback handlers lack explicit per-clip identity and consumed protection",
    "medium: web/app.ts:370-386 - source replacement does not explicitly stop and unload the prior owner",
    "medium: web/app.ts:437-454 - document click can resume a seek-to-end pause before end confirmation",
    "medium: tests/test_app.mjs:31-116 - missing reverse-order, duplicate-event, stale-promise, and cleanup coverage"
  ],
  "manualNotes": "Preserve FIFO and autoplay-retry behavior while making owner invalidation precede player.pause() during replacement and rescue."
}
```

[38;2;136;136;136m✻ Turn took 2m 4s (Total time 2m 4s · 1 turn)[0m