# Task for test-engineer

Inspect the implemented diff and contract from # Handoff Output: define
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

[38;2;136;136;136m✻ Turn took 1m 52s (Total time 1m 51s · 1 turn)[0m. Add only focused regression coverage for both failures: two concurrent audio sources must not survive as independent playback, and ending by natural completion or seeking to the end must advance once without restarting the current clip. Follow existing browser test helpers and the concurrency/test-hazards guidance; stub external audio/network behavior. Run the focused tests and rebuild static output if the test workflow requires it.

---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785999378987544477_3719023_0/tests.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

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
    },
    {
      "id": "criterion-2",
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