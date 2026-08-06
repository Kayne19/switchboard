# Task for plan-reviewer

Challenge # Handoff Output: plan
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

[38;2;136;136;136m✻ Turn took 2m 4s (Total time 2m 4s · 1 turn)[0m against # Handoff Output: explore
Status: success
Verdict: (none)
Timestamp: 1785999651

## Content
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

[38;2;136;136;136m✻ Turn took 2m 27s (Total time 2m 27s · 1 turn)[0m. Check for races between automatic iteration and user seek, duplicate ended/timeupdate callbacks, stale player instances, pause semantics, queue corruption, and whether tests actually reproduce both reported failures. State concrete amendments for the implementer and finish with APPROVE or REVISE. Do not edit code.

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785999378987544477_3719023_0/review_plan.md
Do not call contact_supervisor merely because no write-capable tool is available.
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```