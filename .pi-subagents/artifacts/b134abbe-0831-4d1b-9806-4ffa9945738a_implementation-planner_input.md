# Task for implementation-planner

Based on the exploration and research handoffs, derive an ordered implementation plan. Prefer fixing shared lifecycle/state roots over caller-specific guards. Include exact files, tests for duplicate-stream prevention and skip-to-next behavior, runtime error handling, and model-picker catalog behavior. Explicitly state how to prove the three requested models are shown or what external config is missing. Do not edit files.

## Context from phase 'research'
# Handoff Output: research
Status: success
Verdict: (none)
Timestamp: 1785993720

## Content
# Evidence audit

## Existing safeguards

- **Clip deduplication is sound:** `src/api.rs:1088-1130` protects the bounded `accepted_clips` set with a mutex, ACKs retransmits, and queues only fresh IDs. Browser outbox reconciliation is ID-based (`web/app.ts:170-205`). **Confidence: high.**
- **Turn cancellation is mostly sound:** rescue increments `turn_generation`, aborts registered operations, and closes the active session (`src/api.rs:514-528`). Dispatch and reply delivery recheck the epoch (`src/api.rs:445-449`, `798-823`). Tests cover rescue cancellation and stale queued turns (`src/api.rs:1383-1510`). **Confidence: high.**
- **WebSocket writes are serialized** through the single `websocket` select loop (`src/api.rs:948-1000`), unlike the legacy implementation’s explicit per-client send locks (`legacy/backend/main.py:185-207`). **Confidence: high.**

## Findings

1. **High: audio producers are not globally ordered or epoch-tagged.**  
   Mid-turn `/speak` text enters `speech` and is synthesized by `process_speech` (`src/api.rs:727-751`, `272-300`), while settled replies synthesize directly (`src/api.rs:853-881`). `Event::Audio` contains only bytes (`src/api.rs:56-60`). Completion timing, not utterance order, determines browser FIFO. `/speak` audio also survives rescue because its worker is not registered with cancellation. **Inference from direct control flow; confidence high.**  
   Minimal fix: assign audio sequence/generation metadata and funnel both producers through one ordered sender; drop queued audio on epoch change.

2. **High: native skip can replay or requeue the wrong clip.**  
   The player is native controls (`static/index.html:711`). `pause` requeues `currentBlob` (`web/app.ts:402-416`), while `ended` clears it and calls `playNext` (`402-405`). Seeking to the end can produce `pause` and `ended` in either observable order; there is no consumed-item identity. **Event-order claim is browser-behavior inference; confidence medium-high.**  
   Minimal fix: track a clip token/consumed state and ignore pause for an already-ended token; add a browser event-order regression test.

3. **High: recorder stop/start can corrupt clips.**  
   `chunks` and `discard` are global (`web/app.ts:66-71`); `stopRecording` treats `state === inactive` as finished without waiting for `onstop` (`web/app.ts:887-900`). A rapid new recording resets `chunks` before the old callback (`841-870`) runs. `recorder.start()` is outside the `try`, and no `onerror` cleanup exists (`874-875`). **Confidence high.**  
   Minimal fix: keep chunks/discard per recorder instance, block start until old `onstop`, and catch `start()` plus recorder errors.

4. **High: stale transcripts are still durable and visible.**  
   Generation is correctly stamped on acceptance (`src/api.rs:1119-1121`) and checked before steering/queueing (`365-374`), but history and the transcript event are written first (`344-353`). The test deliberately asserts this behavior (`src/api.rs:1553-1595`). **Confidence high.**  
   Minimal fix: check the epoch before logging/broadcasting; update the conflicting test.

5. **Medium-high: late thinking callbacks lack session identity.**  
   The extension posts only `{thinking}` (`extensions/agent-switchboard.ts:35-58`); `LiveLegState::report_thinking` validates only route/current value (`src/pbx.rs:92-104`), and `/leg-state` publishes directly (`src/api.rs:709-720`). A callback from a replaced process can overwrite the new leg. **Confidence medium-high.**  
   Minimal fix: include a session/generation token in the callback and reject stale tokens.

6. **Medium: same-generation operator controls can publish out of order.**  
   Operator `/thinking` and `/model` use `spawn_active_operation`, which captures but does not advance generation (`src/api.rs:233-251`, `624-674`). The browser disables only the changed select (`web/app.ts:498-521`), so different controls can overlap. **Confidence high.**  
   Minimal fix: serialize all page controls with one operation sequence, or disable all route/model/thinking controls together.

7. **Medium-high: catalog refresh is lazy and effectively permanent.**  
   Catalogs are fetched only from `resolve_model` (`src/pbx.rs:1081-1112`), cached by host/runtime, and exposed only from that cache (`src/pbx.rs:289-316`). A default transfer exits early without fetching (`1129-1132`), so the picker shows only the current-model fallback (`web/app.ts:476-487`). No TTL or refresh path exists. **Confidence high.**  
   Minimal fix: fetch on project activation or add explicit TTL/invalidation; expose availability separately from an empty catalog.

8. **High under strict catalog attestation: failed discovery permits arbitrary qualified models.**  
   `fetch_catalog` maps failures and malformed/empty output to `entries: []` (`src/models.rs:297-370`), and `resolve` accepts any `provider/model` in that state (`211-220`). Existing tests codify it (`426-433`; PBX transfer test `1667-1697`). **Confidence high.**  
   Minimal fix: represent unavailable catalogs distinctly and reject unverified selections, while preserving startup fallback behavior.

## GPT 5.6, Luna, and Sol

No authoritative local project registry, environment file, or catalog fixture contains these names. Runtime configuration is external (`src/main.rs:67-97`, default `/etc/switchboard/projects.json`), and model discovery runs on the target host, locally or via SSH (`src/pi_client.rs:753-766`). Prior-run `.pi-subagents` metadata mentioning `openai-codex/gpt-5.6-luna` is not application configuration. **Availability cannot be proved here; confidence high.** Verify canonical IDs, credentials, and startup on each deployment host with `pi --list-models`.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete concurrency, audio, stale-reply, catalog, and deployment-evidence findings with file and line references, confidence, and minimal-fix options."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read active Rust and TypeScript paths, generated browser target, legacy baseline, concurrency documentation, and relevant Rust/browser tests."
  ],
  "residualRisks": [
    "Browser pause/ended ordering and recorder races lack runtime tests.",
    "Deployment catalogs, credentials, remote SSH reachability, and canonical GPT 5.6/Luna/Sol IDs are outside this repository.",
    "Existing stale-transcript and empty-catalog tests encode behavior contrary to strict stale-data and catalog-attestation requirements."
  ],
  "noStagedFiles": true,
  "diffSummary": "Inspection only; no files changed.",
  "reviewFindings": [
    "high: src/api.rs:56-60,272-300,727-751,853-881 - audio producers lack shared ordering and epoch metadata",
    "high: web/app.ts:402-416 - pause/ended handling can replay or requeue clips",
    "high: web/app.ts:66-71,841-875,887-900 - recorder lifecycle can race and corrupt chunks",
    "high: src/api.rs:344-374 - stale transcripts publish before epoch validation",
    "medium-high: src/pbx.rs:92-104, src/api.rs:709-720 - stale leg-state callbacks lack identity",
    "medium-high: src/pbx.rs:1081-1112, src/models.rs:211-220 - lazy catalog and unverified qualified-model fallback"
  ],
  "manualNotes": "Run pi --list-models on every authoritative project host and record canonical provider/model IDs before claiming GPT 5.6, Luna, or Sol availability."
}
```

[38;2;136;136;136m✻ Turn took 2m 56s (Total time 2m 55s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785993137994978505_3627287_0/plan.md
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