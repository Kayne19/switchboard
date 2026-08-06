# Task for implementation-engineer

Inspect the repository and apply the smallest safe fix based on # Handoff Output: plan
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

[38;2;136;136;136m✻ Turn took 2m 4s (Total time 2m 4s · 1 turn)[0m and # Handoff Output: review_plan
Status: success
Verdict: REVISE
Timestamp: 1785999925

## Content
# Adversarial playback-plan review

1. **High:** `web/app.ts:392-405`  
   The rejection path must invalidate and clean up the owner before requeueing. If it unshifts the blob while retaining the active owner, a later successful resume plays A, then FIFO plays requeued A again. Specify one-shot rejection handling: invalidate owner, pause/remove `src`/`load`/revoke, then unshift exactly once.

2. **High:** `web/app.ts:437-454`  
   Attempt tokens prevent stale settlements but do not prevent repeated document clicks from issuing multiple `play()` calls before the first resolves. Add a pending-resume guard and test two clicks before resolution, including one rejection followed by retry.

3. **High:** `web/app.ts:386-406`, proposed pause semantics  
   A `pause` caused by `src` replacement or `load()` can occur while initial `play()` is pending. “Pause invalidates pending continuation” can suppress the required autoplay-rejection requeue. Distinguish setup/cleanup pauses from user pauses, and test pending-play rejection after each.

4. **Medium:** `web/app.ts:420-425`  
   Terminal seek handling can wedge playback: a paused seek to `duration` may not emit `ended` until playback resumes, while the plan forbids resume; seeking backward before confirmation can leave a sticky terminal flag. Define reset behavior using `timeupdate`/`seeking`/`seeked` or a fresh duration check, with tests for reverse seek, duplicate `timeupdate`, and `NaN`/infinite duration. Never consume solely on `timeupdate`.

5. **Medium:** `tests/test_app.mjs:31-116`  
   The extracted test section does not exercise epoch rescue or binary-frame admission. Add coverage invoking the shared cleanup through rescue, asserting old callbacks/promises cannot mutate state, cleanup occurs once, and binary audio arriving during an ordinary pause queues behind the owner.

6. **Medium:** listener detachment needs a real retained-listener fake. Verify old A callbacks manually after B starts, rather than relying only on a map that replaces handlers; otherwise listener accumulation and stale dispatch remain untested.

Residual risk: the tests are transpiled lifecycle tests, not browser media tests. Actual `src` setter timing, native pause emission, autoplay policy, and whether paused terminal seeks emit `ended` still require browser instrumentation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete severity-rated race and validation findings are identified with repository paths and line ranges, including required implementation amendments."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Inspected web/app.ts, tests/test_app.mjs, static/index.html, package.json, and docs/concurrency-and-test-hazards.md.",
    "Confirmed one native audio element and identified unresolved rejection, duplicate-click, pending-pause, seek, and rescue-test gaps."
  ],
  "residualRisks": [
    "Browser-specific media event scheduling and autoplay behavior remain unverified without manual instrumentation or browser tests."
  ],
  "noStagedFiles": true,
  "diffSummary": "Review only; no files changed.",
  "reviewFindings": [
    "high: web/app.ts:392-405 - rejection requeue can duplicate playback unless owner teardown precedes unshift",
    "high: web/app.ts:437-454 - repeated clicks can issue duplicate resume play() calls",
    "high: web/app.ts:386-406 - setup/cleanup pause can conflict with pending-play rejection handling",
    "medium: web/app.ts:420-425 - terminal seek confirmation can wedge or remain stale after reverse seeking",
    "medium: tests/test_app.mjs:31-116 - rescue, binary admission, and retained stale callbacks are not exercised"
  ],
  "manualNotes": "Revise the plan with explicit rejection teardown, pending-resume suppression, setup-pause discrimination, terminal-seek reset rules, and rescue-path tests."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 2m 20s (Total time 2m 20s · 1 turn)[0m. Re-read the actual symbols before editing. Fix the shared playback/queue ownership or lifecycle root cause, not just one caller. Add or update focused tests where the existing test structure calls for it, rebuild committed static browser output when source changes, and run targeted checks. Do not touch deployment or homelab files. Report changed files and commands/results.

---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785999378987544477_3719023_0/implement.md
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