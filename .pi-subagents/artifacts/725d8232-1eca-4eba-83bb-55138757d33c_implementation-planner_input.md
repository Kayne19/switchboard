# Task for implementation-planner

Using # Handoff Output: define
Status: success
Verdict: (none)
Timestamp: 1785999498

## Content
# Playback bug contract

**Outcome:** For all reply audio caused by one caller utterance, the browser has at most one audible playback owner. Pausing stops every owner. Seeking a clip to its end consumes it once and advances FIFO to the next clip once.

**Definitions:** A clip is one queued audio blob. “Consumed” means removed from current playback exactly once. A pause caused by seeking to the end is terminal only when paired with end confirmation, not an ordinary user pause.

## Invariants

1. **Single owner:** At most one audio element/source is actively audible. Replacing or advancing a clip pauses and cleans up the previous owner; no hidden stream remains.
2. **Pause:** Ordinary pause leaves the current clip retained, does not requeue or consume it, and leaves later clips queued. Resume continues that same clip.
3. **Queue:** Clips advance FIFO. A clip is dequeued/consumed once, never both retained and queued.
4. **End/seek:** End-of-clip processing is idempotent. `pause`/`ended` may arrive in either order after seeking to duration, but produce one consumption and one advancement.
5. **Stale events:** Events, play-promise settlements, and errors from an older clip cannot mutate the current clip, queue, or playback state.
6. **Duplicate events:** Repeated `ended`, `pause`, or `error` events cannot replay a consumed clip, skip the next clip, or start a second owner.

## Acceptance scenarios

- With clips A then B, starting A creates one active owner. Pausing the visible player leaves no audible owner; A remains current and B remains queued.
- Resuming after that pause plays A, not a requeued duplicate. B does not start early.
- Seeking A to its end with `pause → ended` advances exactly once to B. The same holds for `ended → pause`.
- Repeating either event after advancement leaves B current and starts B no more than once.
- A stale A event or `play()` rejection after B starts does not requeue A or alter B.
- Legitimate multiple audio clips from one utterance play sequentially, never simultaneously.

## Evidence and boundaries

- `web/app.ts:368-454` and mirrored `static/app.js:314-397` use global player state; media handlers have no explicit per-clip event identity or consumed latch. **High risk:** late events can affect a newer clip.
- `static/index.html:711` exposes one native player, so the reported “second stream” is not proven by source alone; runtime instrumentation must identify whether it is a second media owner or duplicate/restarted playback.
- `tests/test_app.mjs:90-116` does not cover both event orders without an intervening click, duplicate events, or hidden-owner detection. **Medium coverage gap.**
- `docs/concurrency-and-test-hazards.md:8-63` documents turn-epoch races, not browser playback ownership; those concerns must not be conflated.
- Non-goals: microphone recording lifecycle, server TTS generation/order, and model routing.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The artifact gives concrete playback findings with severity, paths, invariants, and measurable acceptance scenarios."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read docs/concurrency-and-test-hazards.md, web/app.ts, static/app.js, static/index.html, and tests/test_app.mjs."
  ],
  "residualRisks": [
    "The second audible owner is not identifiable from static source inspection alone.",
    "Existing tests do not prove duplicate-event idempotence or hidden-owner cleanup."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; bug contract only.",
  "reviewFindings": [
    "high: web/app.ts:368-454 - playback handlers lack explicit per-clip event identity/consumed protection",
    "medium: tests/test_app.mjs:90-116 - incomplete event-order and duplicate-event coverage"
  ],
  "manualNotes": "Runtime reproduction should instrument every audio owner while testing pause and seek-to-end event permutations."
}
```

[38;2;136;136;136m✻ Turn took 1m 52s (Total time 1m 51s · 1 turn)[0m and # Handoff Output: explore
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

[38;2;136;136;136m✻ Turn took 2m 27s (Total time 2m 27s · 1 turn)[0m, derive a minimal root-cause fix rather than caller-specific guards. Map source files, tests, generated static updates, and runnable checks. The plan must make playback ownership explicit, make pause stop every path that can continue playback, and make end/skip advancement idempotent so a clip cannot restart or advance twice. Avoid server changes unless the trace proves they are required. Do not edit code.

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785999378987544477_3719023_0/plan.md
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