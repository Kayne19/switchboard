# Handoff Output: review_v3
Status: success
Verdict: REVISE
Timestamp: 1786004323

## Content
# Adversarial review

1. **High: remote same-session quiescence remains unproven.** Plan §3 only guarantees local `PiSession::close` reaping (`src/pi_client.rs:540-560`). Remote legs use SSH (`src/pi_client.rs:796-835`), and killing local SSH does not guarantee the remote Pi process released its session file. The deterministic test covers only a local fake process. Define a remote shutdown/acknowledgement or remote lock strategy, and test it.

2. **High: speech success and TTS fallback are underspecified.** Current `/speak` queues TTS and returns before synthesis (`src/api.rs:849-897`), while `speak` is recorded at tool start (`src/pi_client.rs:410-438`). “Accepted successful callback” does not establish successful playback. Specify the callback acknowledgement contract and tool-result correlation, then test accepted callback plus TTS failure still synthesizes the written reply.

3. **High: sole lifecycle ownership omits `AppState::activity_clock`.** The plan explicitly moves activity into `CallLifecycle`, but only lists removal of `active_session`, `live_leg`, generation, transition, and status fields. `AppState::activity_clock` remains in the stated mapping (`src/api.rs:47,193-214,504`), leaving duplicate mutable activity state unless explicitly removed or reclassified.

4. **Medium: trace/sanitization requirements lack explicit tests.** §6 requires a 256-entry ring, monotonic sequence, 128-byte string caps, 2 KiB diagnostics, UTF-8-safe truncation, and exclusion of tokens/prompts/transcripts/stderr/paths/secrets, but no slice requires tests for these invariants.

The coordinator scope is otherwise coherent: configuration and adapters remain outside it, and candidate callback rejection plus same-session fallback are clearly stated. The unresolved remote guarantee and speech outcome contract block approval.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "The plan leaves remote same-session process quiescence and successful-speech/TTS fallback behavior ambiguous, and does not explicitly remove AppState activity ownership."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Findings cite concrete source symbols, failure modes, and required plan corrections."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read-only review of plan_v3 against review_v2 blockers and repository contracts."
  ],
  "residualRisks": [
    "Remote SSH child termination may leave a same-session Pi process alive.",
    "Asynchronous TTS acknowledgement may suppress fallback incorrectly."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; architecture plan review only.",
  "reviewFindings": [
    "high: remote same-session quiescence is not guaranteed or tested",
    "high: speech callback success versus TTS success is unspecified",
    "high: AppState activity_clock is not explicitly removed",
    "medium: trace and sanitization invariants lack explicit tests"
  ],
  "manualNotes": "The plan is close, but these are architecture-gate blockers."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 44s (Total time 3m 43s · 1 turn)[0m