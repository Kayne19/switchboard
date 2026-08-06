# Task for plan-reviewer

Perform the final read-only gate on `plan_v4`. Verify all prior findings are closed, especially: AppState activity removal, deterministic remote SSH same-session lock/no-overlap safety, exact asynchronous `/speak` acknowledgment and TTS fallback semantics, successful-tool-result speech tracking, and explicit trace sanitization/ring-bound tests. Reject any remaining ambiguity or scope creep. End exactly with `VERDICT: APPROVE` or `VERDICT: REVISE`.

## Final revised plan
# Handoff Output: plan_v4
Status: success
Verdict: (none)
Timestamp: 1786004656

## Content
# plan_v4: implementation plan

**Scope:** read-only; preserve one-caller ephemerality, existing wire shapes, legacy compatibility, unavailable-catalog passthrough, diagnostics-only phase status, and homelab separation.

## Ordered slices

1. **Make lifecycle ownership singular.**  
   In `src/pbx.rs`, add `CallLifecycle` owning route, project, sessions, persistent `session_id`, per-process `leg_token`, generation, phase, operation identity, terminal note, `ActivityClock`, and diagnostic trace. Remove these fields and helpers from `Switchboard`, including `active_session`, `live_leg`, `last_activity`, `activity_clock()`, `touch_activity()`, and `live_leg_state()`.  
   In `src/api.rs::AppInner`, remove `active_session`, `activity_clock`, `live_leg`, `turn_generation`, `operation_transition`, and authoritative status mirrors. API idle/status/callback paths query or mutate lifecycle only through coordinator commands (`IdleDrop`, `Snapshot`, `AcceptCallback`, `TouchActivity`, `TurnIdentity`, etc.). Transport queues and task registries remain API-owned.

2. **Retain transactional candidate adoption.**  
   Refactor `Switchboard::{transfer,start_agent,redial,drop_agent,force_hangup}` around `CandidateLeg`. Candidates never become visible or accept callbacks. Adoption atomically commits route, model, session ID, token, generation, phase, and event. Rescue closes only the candidate when an authoritative leg remains; otherwise settle to operator. Candidate callbacks return bounded `409` JSON and are never buffered.

3. **Make remote same-session locking deterministic.**  
   Extend `src/pi_client.rs::remote_argv` with a deterministic lock path derived from `host + NUL + persistent session_id` using bounded hex encoding. Emit a remote shell sequence equivalent to:
   `exec 9>lock; flock -n 9 || { bounded diagnostic; exit 75; }; exec pi ...`.  
   FD 9 is inherited by Pi, so the lock lasts for the remote Pi process lifetime, not merely SSH startup. `flock` failure is immediate, never waited on.  
   Same-session redial closes stdin, terminates the local SSH process tree, awaits reaping, then starts the candidate. If remote Pi or SSH teardown still holds the lock, candidate startup fails, local resources are reaped, bounded `remote_session_lock_busy` is recorded, and lifecycle settles to operator. No unsafe rollback or overlap is attempted. New-session candidates retain normal transactional overlap behavior. Prompt remote termination latency and remote `flock` availability remain host-validation risks.

4. **Define speech delivery as an acknowledged outcome.**  
   Add a oneshot to `SpeechRequest`. `/speak` validates the real current leg token, captures generation and a browser-connection epoch, and returns only after `process_speech` reports an outcome. `process_speech` acknowledges success only after TTS succeeds, generation/socket epoch still match, a browser remains connected, and `finish_audio` commits the audio event.  
   Return `200 {"delivered":false,...}` only for no browser; return bounded non-2xx for TTS failure, stale generation, invalid/candidate token, or worker failure. Do not claim queued work is delivered.  
   Update `extensions/agent-switchboard.ts` to send the token and mark HTTP failures and `delivered:false` as `isError`.  
   In `src/pi_client.rs::{Signal,Turn,collect}`, correlate `tool_execution_start` and `tool_execution_end` by `toolCallId`; `Turn::agent_spoke()` is true only for a successful completed `speak`, never for start-only or `isError` results. Written replies therefore remain fallback-synthesized after failed speech.

5. **Add stale-result barriers and preserve approved contracts.**  
   Route all awaited commits through lifecycle identity checks in `src/pbx.rs::{handle,handle_agent,process_turns,deliver_turn_if_current}` and `src/api.rs::{process_clips,process_speech,deliver_page_reply_if_current,synthesize_reply_if_current}`. Preserve capture-generation stamping, reconnect ordering `epoch → status → history → diagram`, provider-qualified unavailable-catalog passthrough, and legacy sentinel/RPC compatibility.

6. **Specify and test bounded diagnostics.**  
   Implement the lifecycle trace as an in-memory 256-entry ring with a process-global monotonic sequence. Cap every UTF-8 field at 128 bytes without splitting code points; cap serialized diagnostic payloads at 2 KiB. Permit only phase/event names, bounded labels, counts, and codes; exclude tokens, prompts, transcripts, stderr, paths, secrets, and raw tool arguments.

## Required tests

- `src/pbx.rs`: serialized coordinator commands; sole activity ownership; idle/status queries; candidate callback rejection; same-session local quiescence; `fake_ssh_same_session_lock_serializes_remote_processes` proving maximum concurrent same-session processes is one, lock-busy candidate failure, release-before-successful-reopen, and operator settlement.
- `src/api.rs`: `speak_waits_for_tts_ack`; accepted callback followed by TTS failure; written-reply fallback synthesis; no-browser `delivered:false`; stale-generation rejection; current/candidate/stale token rejection; status and idle paths without API lifecycle mirrors.
- `src/pi_client.rs`: `speak_signal_requires_successful_tool_execution_end`, including start-only, failed end, successful end, and mismatched `toolCallId`; remote lock command quoting.
- `tests/test_extensions.mjs`: token in state/speak/diagram bodies; non-2xx and `delivered:false` produce `isError`; successful acknowledged delivery remains successful.
- `src/pbx.rs` trace tests: 256-entry retention, process-lifetime monotonic sequence, UTF-8-safe 128-byte caps, serialized payload `<=2 KiB`, and explicit exclusion of token/prompt/transcript/stderr/path/secret markers.

## Rejected alternatives

- Waiting for remote SSH teardown: nondeterministic and cannot guarantee safety.
- Concurrent same-session Pi processes, history cloning, or rollback: unsafe session-file access.
- Treating queued TTS as delivery: lies to the agent and suppresses fallback.
- Capturing `speak` at tool start: loses tool-result correlation.
- API activity/status mirrors, durable trace storage, Postgres, Redis, run queues, browser lifecycle state, or homelab edits.

## Exact file/symbol mapping

- `src/pbx.rs`: `CallLifecycle`, `CandidateLeg`, `ActivityClock`, coordinator commands/queries, `Switchboard` facade, `resolve_model`, trace tests.
- `src/api.rs`: `AppInner`, `process_speech`, `speak`, `status`, `healthz`, `leg_state`, idle workers, stale barriers, endpoint tests.
- `src/pi_client.rs`: `remote_argv`, `PiSession::close`, `Signal`, `Turn::agent_spoke`, `collect`, lock and correlation tests.
- `extensions/agent-switchboard.ts`: token bodies and delivery-error handling.
- `src/models.rs`: unavailable-catalog tests.
- `tests/test_extensions.mjs`, `tests/test_protocol.mjs`, legacy tests: compatibility coverage.
- `README.md`, `docs/concurrency-and-test-hazards.md`, `docs/observability-and-coverage-handoff.md`, `docs/rust-typescript-migration-handoff.md`: lifecycle, locking, speech, trace, environment, and deployment-boundary documentation.

## Acceptance commands

```text
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm test
git diff --exit-code -- static
```

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Plan explicitly removes AppState::activity_clock and facade activity ownership, defines remote flock locking and operator fallback, specifies acknowledged speech outcomes and tool-result correlation, and adds direct trace invariant tests."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection and plan revision",
      "result": "not-run",
      "summary": "Planning only; no source files edited."
    }
  ],
  "validationOutput": [
    "Mapped every review_v3 blocker to concrete symbols, mechanisms, deterministic tests, and acceptance commands."
  ],
  "residualRisks": [
    "Remote process termination latency and remote flock availability require host validation.",
    "Callback tokens provide correlation, not authentication.",
    "Live SSH, TTS, STT, credentials, hardware, and homelab cutover remain external validation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No source changes; revised implementation plan only.",
  "reviewFindings": [
    "high: src/pi_client.rs::remote_argv - plan_v3 lacked deterministic remote same-session exclusion.",
    "high: src/api.rs::process_speech and speak - plan_v3 treated queued TTS as successful delivery.",
    "high: src/api.rs::AppInner - plan_v3 did not explicitly remove activity_clock ownership.",
    "medium: src/pbx.rs diagnostic trace - plan_v3 lacked direct retention, sequence, UTF-8, size, and exclusion tests."
  ],
  "manualNotes": "The artifact is complete and is persisted by the runtime to the configured plan_v4.md path."
}
```

[38;2;136;136;136m✻ Turn took 3m 48s (Total time 3m 47s · 1 turn)[0m

## Prior review
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
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/review_v4.md
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