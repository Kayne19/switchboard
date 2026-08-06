# Task for evidence-researcher

Using the codebase and tests as primary evidence, audit sibling callers and existing concurrency safeguards for duplicate audio, skip transitions, cancellation, stale replies, and model catalog refresh. Check whether GPT 5.6, Luna, and Sol are present in local configuration/catalogs or only expected from deployment. Produce concrete claims with file/line evidence and minimal-fix options. Do not edit files.

## Context from phase 'explore'
# Handoff Output: explore
Status: success
Verdict: (none)
Timestamp: 1785993539

## Content
# Repository exploration

## End-to-end map

- Authoritative runtime is Rust (`src/`); browser source is `web/`, with committed output in `static/`. `legacy/` is compatibility-only.
- Browser recording: `web/app.ts:startRecording` (795-881) -> `clipHeader` (`web/protocol.ts:18-31`) + binary WebSocket frame -> `src/api.rs:handle_audio_frame` (1073-1137).
- Backend deduplicates clip IDs through `accepted_clips` (44, 1088-1130), queues `Clip`, runs `process_clips` (303-428), invokes `SttAdapter::transcribe` (`src/audio.rs:105-190`), logs/broadcasts transcript, then either steers `PiSession` or queues a generation-stamped turn.
- `process_turns` (429-499) serializes PBX work. `Switchboard::handle` routes operator/project turns (`src/pbx.rs:350-567`).
- `PiSession` lifecycle is `start` (100-161), `prompt`/`steer` (215-275), JSONL collection (277-467), and `close`/process-tree cleanup (197-213, 499-558).
- Reply TTS is `synthesize_reply_if_current` (`src/api.rs:853-896`); mid-turn `speak` uses `/speak` -> `process_speech` (273-300). Both emit untagged `Event::Audio` (56-60, 1142-1146), received by the browser queue (`web/app.ts:363-430, 775-784`).
- Page rescue endpoints `/hangup`, `/connect`, `/thinking`, `/model` are `src/api.rs:544-705`. `cancel_active_operations` bumps `turn_generation`, aborts registered tasks, closes the active session, and emits an epoch event (510-528).

## Findings, ordered by severity

1. **High: native skip/end can replay the current clip.**  
   `web/app.ts:402-414` independently handles `ended` and `pause`. Seeking the native `<audio controls>` player to its duration can deliver `pause` while `player.ended` is still false; the pause handler requeues `currentBlob`, then `ended` advances into the requeued clip. There is no item identity/consumed guard. Touch points: `web/app.ts:363-430`, mirrored `static/app.js`, and `<audio id="player" controls>` in `static/index.html`.

2. **High: recorder stop/start races can create overlapping streams or corrupt clips.**  
   `stopRecording` considers the recorder finished as soon as `state` becomes inactive, but the old `onstop` callback may not have run yet. A rapid Talk click can reset global `chunks` and create a second stream while the first callback still writes into it (`web/app.ts:66-70, 795-900`). `recorder.start()` and `recorder.stop()` are also not protected against synchronous exceptions, and there is no `MediaRecorder.onerror` cleanup path. Touch points: `startRecording`, `stopRecording`, recorder callbacks, and `mediaRecorder`/`chunks`.

3. **High: audio has no generation and producers are not globally FIFO.**  
   `Event::Audio` carries only bytes. Mid-turn `/speak` audio (`src/api.rs:273-300`) and settled-reply TTS (`853-896`) can complete in different orders, so browser FIFO reflects completion timing rather than reply order. Audio already emitted before rescue remains in `audioQueue` and continues after an epoch event; `web/app.ts:687-690` only updates `turnEpoch`. Touch points: `Event`, `process_speech`, `speak`, `synthesize_reply_if_current`, `send_event`, and browser queue/epoch handling.

4. **High: catalog failure permits unverified provider-qualified models.**  
   `fetch_catalog` collapses command failure, timeout, malformed output, and an empty catalog to `ModelCatalog { entries: [] }` (`src/models.rs:297-370`). `ModelCatalog::resolve` then explicitly passes any provider-qualified request through (`211-220`), and `Switchboard::resolve_model`/`redial` can start it (`src/pbx.rs:1081-1112, 1147-1207`). Existing tests codify this behavior (`src/models.rs:426-433`, `src/pbx.rs:1667-1697`). This conflicts with deployment-attested model availability.

5. **High: stale transcripts are published before the epoch check.**  
   `process_clips` logs and broadcasts the transcript at `src/api.rs:344-353`; it checks `clip.generation` only afterward at 367-374. Thus pre-rescue speech is not acted upon, but it is still durable and visible, potentially under the new route. The Rust test intentionally asserts this (`src/api.rs:1550-1595`), which conflicts with the stated “no stale transcript” criterion.

6. **Medium-high: stale thinking reports can overwrite current status.**  
   `agent-switchboard.ts:44-58` posts only a thinking level. `LiveLegState::report_thinking` (`src/pbx.rs:54-78`) validates only the current route, not session identity or generation. A late callback from an old process, especially after same-project model redial, can update the new leg’s status. API handling is `src/api.rs:709-720`.

7. **Medium: same-generation page operations can publish stale status.**  
   `deliver_page_reply_if_current` checks only `turn_generation` (`src/api.rs:798-823`). Operator `/thinking` and `/model` use `spawn_active_operation` without bumping generation; concurrent operations can both complete and publish in either order. Browser controls are independently disabled by `web/app.ts:498-521`, so route/model/thinking requests can still overlap.

8. **Medium: picker population is deferred until model resolution.**  
   `src/pbx.rs:289-316` exposes cached catalog entries, but catalogs are fetched only from `resolve_model` (`1081-1112`). A normal project transfer using its default model therefore announces only the current model, not the authoritative catalog. Failed `/model` requests can also leave the native selection optimistically changed because `web/app.ts:498-521` does not restore the prior value on conflict.

## Test and documentation coverage

- `docs/concurrency-and-test-hazards.md` confirms capture-time epoch stamping, operation-transition locking, process-tree cleanup, and STT broken-pipe diagnosis.
- Rust tests cover rescue cancellation, queued stale turns, stale transcript behavior, PBX lifecycle/model resolution, and fake process execution.
- `tests/test_protocol.mjs` tests serialization only. No test exercises `web/app.ts` MediaRecorder lifecycle, native audio `pause`/`ended`, queue identity, or playback ordering.
- Deployment catalog contents, credentials, remote SSH reachability, and requested names such as GPT 5.6/Luna/Sol cannot be proven from this repository. Remote catalog selection is `src/pi_client.rs:list_models_argv` (753-766).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Mapped the active Rust/TypeScript audio, dispatch, rescue, process, and catalog flows and identified concrete root causes with exact file and symbol references."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read AGENTS.md, README.md, docs/concurrency-and-test-hazards.md, relevant Rust and TypeScript sources, static HTML/build output, active tests, and legacy compatibility tests."
  ],
  "residualRisks": [
    "External deployment catalogs and provider credentials remain unverifiable from source.",
    "Browser playback and recorder races lack runtime tests.",
    "The existing stale-transcript test encodes behavior conflicting with the stated acceptance criterion."
  ],
  "noStagedFiles": true,
  "diffSummary": "Inspection only; no files changed.",
  "reviewFindings": [
    "high: web/app.ts:402-414 - pause/ended ordering can requeue and replay the skipped clip",
    "high: web/app.ts:795-900 - stop/start and recorder exception races can overlap streams or corrupt chunks",
    "high: src/api.rs:273-300,853-896 - audio producers are untagged and not globally FIFO",
    "high: src/models.rs:211-220 - failed catalog discovery permits arbitrary provider-qualified models",
    "high: src/api.rs:344-374 - stale transcripts publish before generation validation",
    "medium-high: src/pbx.rs:54-78 - late leg-state reports lack session/generation identity",
    "medium: src/api.rs:798-823 - same-generation operations can publish stale status"
  ],
  "manualNotes": "Verify requested model IDs with pi --list-models on each authoritative project host, especially remote hosts selected by list_models_argv."
}
```

[38;2;136;136;136m✻ Turn took 4m 37s (Total time 4m 37s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785993137994978505_3627287_0/research.md
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