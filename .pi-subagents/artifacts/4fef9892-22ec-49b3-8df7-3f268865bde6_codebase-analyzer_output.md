# Playback review

## Map and data flow

- Recent HEAD: `e1e8f532` (“Format picker operation chain”), parent `62ff8828` (“Harden audio lifecycle and model catalog”).
- One native player exists: `static/index.html:711`, initialized by `web/app.ts:63`; no `new Audio`, `AudioContext`, `MediaSource`, or second player was found.
- Server audio is FIFO before browser delivery: `src/api.rs:75-131` reserves/finishes ordered slots, then sends metadata followed by binary audio at `src/api.rs:1264-1274`.
- Browser binary frames enqueue at `web/app.ts:878`; `playNext()` consumes FIFO using `currentBlob || audioQueue.shift()` at `web/app.ts:368-386`.
- Generated output mirrors this in `static/app.js:314-400`; `static/index.html` loads only `/app.js`.

## Findings

- **High: stale media events are not clip-scoped.**  
  `web/app.ts:409-433` and `static/app.js:353-380` use global `player` state and `currentBlob` without event identity or a consumed latch. A late `pause` can set `isPlaying = false` for the next clip; a late `error` can clear the next clip and advance again; a late/duplicate `ended` can consume the wrong clip when `player.ended` is true. This violates stale-event and idempotence invariants.

- **Medium: replacement relies on implicit browser behavior.**  
  `web/app.ts:370-386` revokes the old URL and assigns `player.src`, but does not explicitly pause/clean the old owner before replacement. The source contains only one native element, so a second audible owner is not proven, but runtime browser behavior around source replacement remains the leading hidden-owner hypothesis.

- **Medium: document click can race seek completion.**  
  `web/app.ts:437-454` resumes any retained clip on any document click. If a seek interaction produces `pause` before `ended` and its click bubbles, `play()` may restart the terminal clip before end confirmation.

- **Medium coverage gap:** `tests/test_app.mjs:90-116` covers only `pause → click/resume → ended`. It does not cover `ended → pause`, duplicate events, stale errors, stale play rejections, or owner cleanup. Its fake player does not model `paused`, `pause()`, `load()`, or `error`.

## Cleanup and listener audit

Epoch rescue at `web/app.ts:769-780` clears the queue, increments playback generation, pauses, revokes the URL, removes `src`, and calls `load()`. Promise callbacks are generation/blob guarded at `web/app.ts:389-406` and `444-452`. No duplicate media listeners or additional audio owners were found.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Mapped all browser audio creation, queue, play, pause, ended, error, replacement, epoch cleanup, server delivery, generated output, and browser-test paths with severity-rated findings."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Inspected .git/logs/HEAD, web/app.ts, static/app.js, static/index.html, src/api.rs, tests/test_app.mjs, and related audio/server paths.",
    "Found one native audio element and no alternate Audio/API-based playback owner."
  ],
  "residualRisks": [
    "Static inspection cannot identify whether the reported second stream is a browser source-replacement artifact, another tab, or runtime duplication.",
    "Stale media-event behavior is not covered by existing tests."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; review-only playback investigation.",
  "reviewFindings": [
    "high: web/app.ts:409-433 and static/app.js:353-380 - media handlers lack clip identity and consumed protection",
    "medium: web/app.ts:370-386 and static/app.js:314-332 - replacement does not explicitly pause the prior owner",
    "medium: web/app.ts:437-454 and static/app.js:384-400 - document click resume may race seek-to-end events",
    "medium: tests/test_app.mjs:90-116 - incomplete event-order, duplicate-event, stale-event, and owner-cleanup coverage"
  ],
  "manualNotes": "Instrument player events, src changes, play/pause calls, and every browser tab during runtime reproduction."
}
```

[38;2;136;136;136m✻ Turn took 2m 27s (Total time 2m 27s · 1 turn)[0m