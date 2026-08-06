# Task for implementation-planner

Revise `plan_v3` using `review_v3` and close all remaining blockers with exact mechanisms and tests:

1. Activity ownership: explicitly remove `AppState::activity_clock` and any duplicate activity clock from the facade; `CallLifecycle` solely owns last-activity state, and API idle/status paths query it through coordinator commands.
2. Remote same-session safety: local close/reap is insufficient for SSH legs. Add a deterministic per-host/session lock strategy to `remote_argv`/remote startup, using a standard remote `flock` lock keyed by host plus persistent session ID and held for the remote Pi process lifetime. Candidate reopen must acquire the lock; if the old remote process or SSH teardown has not released it, candidate startup fails safely and the call settles to operator rather than overlapping session-file access. Specify close/reap behavior, lock acquisition failure, bounded diagnostics, and a fake-SSH test proving max concurrent same-session processes is one and candidate start follows lock release. Treat prompt remote termination latency as an external host-validation risk, but make no-concurrency safety deterministic.
3. Speech outcome contract: `/speak` must not return successful speech merely because it queued work. Define a oneshot acknowledgment from `process_speech` after TTS succeeds and audio is committed for the current generation/socket; return `delivered:true` only then, `delivered:false` for no browser, and a bounded non-2xx error for TTS/stale-generation failure. The extension must mark non-2xx or unsuccessful delivery as `isError`; `PiSession::collect` must derive `agent_spoke` only from successful `tool_execution_end`, never `tool_execution_start`. Add tests for accepted callback + TTS failure + written-reply fallback synthesis, no-browser behavior, stale generation, and tool-result correlation.
4. Trace tests: require direct tests for 256-entry retention, process-lifetime monotonic sequence, UTF-8-safe 128-byte field caps, <=2KiB sanitized payload, and exclusion of tokens/prompts/transcripts/stderr/paths/secrets.

Preserve the already-approved v3 decisions: `CallLifecycle` is the sole mutable lifecycle state machine; `Switchboard` is an async facade with no duplicate lifecycle fields; external callbacks use only real per-process leg tokens; operation/generation identity is internal; candidate callbacks are rejected with no buffering; same-session redial quiesces before reopen; unavailable-catalog passthrough, diagnostics-only phase status, one-caller ephemerality, legacy compatibility, and homelab separation. Do not edit source files. End with exact file/symbol mapping and acceptance commands.

## Context from phase 'review_v3'
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

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v4.md
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