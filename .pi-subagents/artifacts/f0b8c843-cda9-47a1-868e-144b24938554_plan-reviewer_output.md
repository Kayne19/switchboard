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

[38;2;136;136;136m✻ Turn took 2m 20s (Total time 2m 20s · 1 turn)[0m