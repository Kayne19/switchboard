# Handoff Output: plan_review
Status: success
Verdict: REVISE
Timestamp: 1785994118

## Content
# Findings

- **High:** `src/api.rs:727-773` and `extensions/agent-switchboard.ts:76-112` have no session token on `/speak`. A stale agent can POST after rescue, receive the new generation, and inject speech into the replacement leg. Generation-at-acceptance alone cannot prevent this.
- **High:** Planned stale transcript dropping leaves `web/app.ts:170-205` outbox entries pending forever. The browser removes clips only on history/transcript/error; no event means an accepted stale clip remains visible and is retransmitted indefinitely.
- **High:** New leg callbacks can be lost. `pbx.rs:613-641` starts the process before publishing its token to `LiveLegState`; `session_start` can report against the old token and is not retried. Also `api.rs:713-723` can publish an older accepted thinking value after a newer callback wins.
- **High:** A shared audio emission lock does not establish producer ordering. `process_speech` (`api.rs:280-290`) and final synthesis (`api.rs:858-881`) can synthesize concurrently; rescue can occur between stale-check and emission unless check-and-send is atomic. The plan needs an ordered enqueue/worker model, not merely a gate around `emit`.
- **High:** Native `<audio>` events carry no clip identity. An old `pause` after `ended` has the same target as the new clip, so token bookkeeping alone cannot distinguish it unless handlers/source transitions explicitly suppress stale events. Both event orders need deterministic guards.
- **Medium:** Recorder cleanup needs a terminal-once path if `onerror` occurs without `onstop`; otherwise “block until prior onstop” can permanently disable recording and leak tracks.
- **Medium:** New browser tests are not wired into `package.json:test` (currently only three existing scripts run), so the proposed regressions can silently remain unexecuted.
- **Medium:** Catalog failure/malformed output is currently collapsed into `entries: []` (`src/models.rs:297-370`). The plan says to distinguish states but does not define malformed-table detection or the browser contract/types for `models_available` and diagnostics.
- **Medium:** Stale STT/TTS work is suppressed only after completion; neither `process_clips` nor `process_speech` is registered for cancellation. Rescue can therefore retain sidecars/network work and emit stale errors.
- **Residual:** `accepted_clips` is a bounded 512-ID cache (`src/api.rs:1088-1130`), not durable replay prevention; an old retransmit after eviction can be logged again.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete race, stale-session, browser-contract, cancellation, catalog, and validation findings are listed with repository paths and line ranges."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Inspected the planned paths in src/api.rs, src/pbx.rs, src/models.rs, web/app.ts, extensions/agent-switchboard.ts, tests, and package.json."
  ],
  "residualRisks": [
    "Target-host model catalogs and canonical GPT 5.6/Luna/Sol IDs remain unverifiable from this repository."
  ],
  "noStagedFiles": true,
  "diffSummary": "Review only; no files changed.",
  "reviewFindings": [
    "high: /speak accepts stale-agent requests because it has no session token.",
    "high: dropped stale clips have no browser acknowledgement and remain in the outbox.",
    "high: leg-state startup and status-publication races remain unspecified.",
    "high: audio ordering and native playback event identity are not fully defined.",
    "medium: recorder terminal cleanup, test wiring, catalog state detection, and cancellation coverage are incomplete."
  ],
  "manualNotes": "Revise the plan to specify session validation, stale-clip acknowledgement, atomic leg-state publication, ordered audio queuing, robust playback suppression, and executable browser tests."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 28s (Total time 3m 27s · 1 turn)[0m