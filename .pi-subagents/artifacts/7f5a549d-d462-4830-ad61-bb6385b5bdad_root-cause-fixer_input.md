# Task for root-cause-fixer

Use the implementation review findings and current diff to patch root causes only. If the review approved the change, perform a no-op confirmation rather than inventing work. Otherwise fix every actionable finding, add or adjust focused regression tests where needed, and run targeted checks. Preserve scope and summarize residual risks. Do not wait for another plan.

## Context from phase 'review'
# Handoff Output: review
Status: success
Verdict: REQUEST_CHANGES
Timestamp: 1785994989

## Content
Findings, ordered by severity:

- **P1:** `web/app.ts:862-914` retains global `chunks` and `discard` across asynchronous `MediaRecorder.stop()`. A new recording can begin while the prior `onstop` is pending, mixing clips or applying the new discard decision to the old clip. Tests use synchronous fake `stop()`, so this race is uncovered.
- **P1:** `web/app.ts:384-406,420-424` has no clip-generation guard. A stale `play()` rejection or media event after advancing can clear `currentBlob`, set `isPlaying = false`, and requeue an already-finished clip, duplicating or skipping playback.
- **P1:** `src/pbx.rs:1129-1133` skips catalog loading for normal blank transfers. `dial()` always supplies blank model arguments, so the first project status has no catalog and `web/app.ts:475-490` exposes only the current model. Alternate models are unavailable until another catalog-loading path occurs. Existing tests pre-cache or fabricate catalog entries and miss this flow.
- **P2:** `web/app.ts:411-429` retains a paused `currentBlob`, but the click-resume handler checks only `audioQueue.length`. A single paused clip is not resumed by the promised page interaction; native resume also leaves `isPlaying` false, so an incoming clip can restart the paused clip.
- **P2:** `web/app.ts:524-545` unconditionally re-enables a picker control in `post()`’s `finally`. A superseded model/thinking request can therefore re-enable controls after `setRoute()` disabled them for a new route or disabled-swap policy, and its late 409 can overwrite newer status.

Residual risk: no real browser/media-device or WebSocket end-to-end validation was performed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Inspected all changed files and callers; identified concrete recorder, playback, catalog-loading, and stale-control races with paths and lines."
    }
  ],
  "changedFiles": [
    "web/app.ts",
    "static/app.js",
    "package.json",
    "tests/test_app.mjs",
    "src/models.rs"
  ],
  "testsAddedOrUpdated": [
    "tests/test_app.mjs",
    "src/models.rs"
  ],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "not-run",
      "summary": "Implement phase reported success; not independently rerun."
    },
    {
      "command": "cargo test --locked",
      "result": "not-run",
      "summary": "Implement phase reported success; not independently rerun."
    }
  ],
  "validationOutput": [
    "Reviewed playback, recorder, picker, catalog, and API callers.",
    "Confirmed current tests do not cover asynchronous recorder stop, stale media callbacks, initial blank-transfer catalog loading, or superseded picker requests."
  ],
  "residualRisks": [
    "No real browser/device or native WebSocket end-to-end run."
  ],
  "noStagedFiles": true,
  "diffSummary": "Browser audio and recorder lifecycle changes, test integration, generated bundle, and model catalog regression coverage.",
  "reviewFindings": [
    "P1 web/app.ts:862-914 - asynchronous recorder stop races with the next recording through global chunks/discard.",
    "P1 web/app.ts:384-424 - stale playback promises/events can duplicate or skip clips.",
    "P1 src/pbx.rs:1129-1133 - blank initial transfers never load the model catalog.",
    "P2 web/app.ts:411-429 - paused single clips are not resumed by page click and can restart on incoming audio.",
    "P2 web/app.ts:524-545 - stale picker requests can re-enable controls and overwrite newer status."
  ],
  "manualNotes": "The implement-phase reported checks were not independently rerun during this review."
}
```
VERDICT: REQUEST_CHANGES

[38;2;136;136;136m✻ Turn took 3m 57s (Total time 3m 57s · 2 turns)[0m

---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785993137994978505_3627287_0/fix.md
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