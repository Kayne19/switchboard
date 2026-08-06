# Ordered implementation plan

1. **Fix shared audio lifecycle in `src/api.rs`.**
   - Extend `Event::Audio` and `AppInner` with generation/sequence state.
   - Route `process_speech` and `synthesize_reply_if_current` through one serialized audio gate/helper.
   - Stamp `/speak` work when accepted; suppress queued or completed synthesis whose `turn_generation` is stale.
   - Preserve JSON runtime errors for TTS failures.
   - Add Rust coverage for producer ordering and stale-audio suppression.

2. **Make transcript publication epoch-safe in `src/api.rs`.**
   - In `process_clips`, check the epoch under `operation_transition` before `TranscriptLog::add_with_id` and the transcript event.
   - Update `clip_accepted_before_a_page_rescue_is_dropped_after_transcription` to require no durable history or transcript event.
   - Keep existing `accepted_clips` ID deduplication unchanged; it is already the shared root for retransmit prevention.

3. **Close recorder lifecycle races in `web/app.ts`.**
   - Refactor `startRecording` and `stopRecording` so chunks/discard state belongs to one recorder instance.
   - Block a new start until the prior `onstop` cleanup completes.
   - Catch `MediaRecorder.start()` and handle `onerror`, stopping tracks and restoring UI in every failure path.
   - Add `tests/test_app_recording.mjs` with fake `getUserMedia`/`MediaRecorder`: double Talk during permission yields one stream, and a rapid stop/start cannot mix chunks or create duplicate clips.

4. **Make native playback identity-aware in `web/app.ts`.**
   - Update `playNext` and the `ended`, `pause`, and `error` handlers to track a clip token and consumed state.
   - Mark a token consumed before advancing; a later `pause` for that token must not requeue it.
   - Add `tests/test_app_audio.mjs` covering end-then-pause and pause-then-end event order, proving the next clip plays exactly once.

5. **Reject stale leg-state callbacks at the lifecycle root.**
   - `src/pbx.rs`: store the active session token in `LiveLegSnapshot`; make `LiveLegState::report_thinking` require and validate it.
   - `src/pbx.rs`: pass the generated `session_id` through the existing `SWITCHBOARD_SESSION` value in `agent_env`.
   - `extensions/agent-switchboard.ts`: include that token in `/leg-state` callbacks.
   - `src/api.rs`: accept the token in `LegState` and return `accepted:false` for stale sessions.
   - Extend `tests/test_extensions.mjs` and Rust API/PBX tests for current and replaced sessions.

6. **Serialize page controls in `web/app.ts`.**
   - Replace per-select locking in `post` with one shared in-flight state covering route, model, and thinking controls.
   - Re-enable controls only after the shared request completes; retain visible errors for HTTP and response-level failures.
   - Test overlapping changes so a second control cannot race the first.

7. **Make model catalogs explicit and refreshable.**
   - `src/models.rs`: distinguish successful empty catalogs from unavailable/malformed discovery; failed discovery must not authorize arbitrary `provider/model` strings.
   - `src/pbx.rs`: add a catalog refresh helper, invoke it on project activation, and expose `models_available` plus a diagnostic field in `Switchboard::status`.
   - Preserve startup fallback to the configured project/default model, but reject explicit unverified swaps.
   - Update `empty_catalog_only_accepts_qualified_models`, `catalog_command_success_and_failure_are_degraded_safely`, and PBX transfer tests.
   - Verify the picker receives every catalog entry through `setRoute` in `web/app.ts`; when discovery is unavailable, show only the current fallback and an unavailable state, not a misleading empty catalog.
   - Add browser/status tests for populated, valid-empty, and unavailable catalogs.

8. **Prove the three requested models externally, not by hardcoding.**
   - No authoritative local registry, environment file, or fixture contains GPT 5.6, Luna, or Sol; `.pi-subagents` metadata is not configuration.
   - On each deployment host, using the configured project runtime, SSH user, credentials, and `pi`, run `pi --list-models` and record canonical `provider/model` IDs.
   - Activate the project, inspect `/status.models`, and confirm those exact IDs become model-select options.
   - If this cannot be done, report the missing canonical IDs, target-host credentials/reachability, runtime installation, or external `/etc/switchboard/projects.json` / `SWITCHBOARD_PROJECTS_FILE` configuration.

9. **Validate with repository gates:** `cargo fmt --all -- --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, `npm test`, and `git diff --exit-code -- static`.

**Rejected alternatives:** caller-specific guards, hardcoded model options, treating catalog failure as an empty catalog, accepting arbitrary qualified models, and adding per-client WebSocket locks. The existing single WebSocket select loop and shared epoch/transition state are the correct roots.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Ordered plan names exact files and symbols, shared lifecycle fixes, duplicate-stream and skip-to-next tests, runtime error handling, catalog behavior, and external proof requirements."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Repository and concurrency guidance inspected; planning only, with no edits."
  ],
  "residualRisks": [
    "Browser event-order tests and deployment catalog verification remain to be implemented.",
    "Canonical IDs and availability of GPT 5.6, Luna, and Sol depend on external hosts, credentials, and runtime configuration."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; implementation plan only.",
  "reviewFindings": [
    "high: src/api.rs:272-300, 853-881 - audio producers are not globally ordered or epoch-tagged.",
    "high: web/app.ts:402-416 - pause and ended can replay or skip the same clip.",
    "high: web/app.ts:841-900 - recorder callbacks share mutable state and start errors are uncaught.",
    "high: src/api.rs:344-353 - stale transcripts are logged and broadcast before epoch validation.",
    "medium-high: src/pbx.rs:92-104 and src/api.rs:713-720 - late thinking callbacks lack session identity.",
    "medium-high: src/models.rs:211-220 and src/pbx.rs:1081-1112 - unavailable catalogs permit unverified models and remain stale."
  ],
  "manualNotes": "Do not claim the three requested models are shown until target-host pi --list-models output and /status model options are recorded."
}
```

[38;2;136;136;136m✻ Turn took 3m 0s (Total time 2m 59s · 1 turn)[0m