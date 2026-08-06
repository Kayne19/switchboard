# Task for implementation-planner

Revise plan_v4 using review_v4 and close every remaining blocker with exact mechanisms, file/symbol mapping, and slice-local tests. Preserve all previously approved decisions: CallLifecycle is the sole mutable lifecycle owner; Switchboard is an async facade without duplicate lifecycle fields; external callbacks use only real per-process leg tokens; operation/generation identity is internal; candidate callbacks are rejected and never buffered; same-session redial quiesces before reopen; unavailable-catalog passthrough; diagnostics-only phase status; one-caller ephemerality; legacy compatibility; no Postgres/Redis/run queue; no homelab edits.

Required corrections:
1. Remote lock safety: define collision-resistant fixed-length derivation for host plus persistent session ID, or reject unrepresentable identities. Specify lock directory, secure creation/permissions, path bounds, and exact failure behavior. Add tests proving distinct identities cannot alias and same-session processes cannot overlap.
2. Speech timeout: reconcile the extension fetch deadline with server TTS timeout. Define one bounded end-to-end deadline, cancellation propagation, and late-result behavior so timeout cannot trigger written-reply fallback while original audio later commits. Add timeout/worker-drop and no-duplicate-speech tests.
3. Audio ordering: when socket epoch or generation becomes stale during TTS, explicitly cancel/finalize the reserved AudioQueue slot so later audio cannot wedge. Add reconnect/disconnect-during-TTS tests.
4. Quiescing: introduce an explicit quiescing phase or callback gate during same-session redial teardown. Reject old-leg /speak, /leg-state, /diagram, and /thinking callbacks during teardown, and test every callback type.
5. Status ownership: explicitly remove or reclassify src/api.rs status_snapshot, current_status, and publish_status. They must be presentation-only projections refreshed from CallLifecycle, never authoritative mutable lifecycle state; add coordinator refresh/ownership tests.

Do not edit source files. End with exact acceptance commands and no unresolved ambiguity for these five items.

## plan_v4
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

## review_v4
# Handoff Output: review_v4
Status: success
Verdict: REVISE
Timestamp: 1786004922

## Content
# Adversarial review

1. **High: remote lock identity is not safety-complete.**  
   `src/pi_client.rs::remote_argv` is specified to use “bounded hex encoding,” but the plan does not define collision handling, rejection of oversized inputs, lock-directory location, or secure creation. Truncation can make distinct `(host, session_id)` pairs share a lock and violate the no-overlap guarantee. Require collision-resistant fixed-length derivation or reject unrepresentable identities, plus a test.

2. **High: `/speak` can still duplicate speech on timeout.**  
   `extensions/agent-switchboard.ts:98-103` has a 30-second fetch timeout, while `src/audio.rs` also allows 30-second TTS requests. The plan adds a oneshot but does not define an endpoint deadline, cancellation, or worker-health mechanism. The extension can mark the tool failed and trigger fallback while the server later delivers the original audio. Define one bounded deadline and cancellation/late-result behavior; test it.

3. **Medium: stale socket results can wedge audio ordering.**  
   `src/api.rs::AudioQueue` reserves ordered slots, while `finish_audio` currently returns early for stale generations. The plan adds socket-epoch rejection but does not specify cancellation/finalization of a reserved slot on epoch mismatch. A disconnected browser can leave sequence N pending forever, blocking later audio. Add an explicit reservation-cancel path and reconnect-during-TTS test.

4. **Medium: same-session quiescing leaves an acceptance window.**  
   During redial, the old token appears to remain authoritative until candidate adoption, while the old SSH process is being terminated. `/speak`, `/leg-state`, or `/diagram` callbacks arriving in that interval may mutate state despite the leg being quiesced. Define a `quiescing` rejection phase and test all callback types, not only candidate callbacks.

5. **Medium: status mirror ownership remains ambiguous.**  
   `src/api.rs::status_snapshot`, `current_status`, and `publish_status` are not named in the removal mapping. If `status_snapshot` remains authoritative, lifecycle state is still duplicated in `AppInner`; if it is only a presentation cache, state that explicitly and require coordinator refresh tests.

The prior explicit blockers are otherwise addressed: activity ownership is named for removal, remote locking is introduced, speech success requires acknowledged TTS/tool completion, and trace retention/sanitization tests are listed. These remaining races and timeout semantics prevent approval.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Plan v4 closes the previously listed blockers in principle, but remote lock identity, asynchronous speech timeout/worker failure, stale audio reservation, callback quiescence, and status mirror ownership remain underspecified."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read-only inspection of plan_v4 against src/api.rs, src/pbx.rs, src/pi_client.rs, src/audio.rs, and extensions/agent-switchboard.ts.",
    "Prior review blockers were checked against the revised plan."
  ],
  "residualRisks": [
    "Lock-key collisions or unspecified lock placement could permit same-session overlap.",
    "A 30-second client/server timeout race can produce duplicate speech.",
    "Socket-stale audio may block subsequent ordered audio.",
    "Callbacks may be accepted while an old leg is being quiesced.",
    "status_snapshot may remain a second lifecycle authority."
  ],
  "noStagedFiles": true,
  "diffSummary": "No source changes; read-only plan gate.",
  "reviewFindings": [
    "high: src/pi_client.rs::remote_argv - bounded lock-key derivation does not specify collision-safe behavior or lock placement.",
    "high: extensions/agent-switchboard.ts:98-103 and src/audio.rs - client and TTS deadlines can trigger fallback while speech is later delivered.",
    "medium: src/api.rs::AudioQueue and finish_audio - stale socket completion lacks reservation cancellation.",
    "medium: src/pbx.rs lifecycle callbacks - quiescing old-leg callback rejection is not explicit.",
    "medium: src/api.rs::status_snapshot - authoritative versus presentation-only ownership is ambiguous."
  ],
  "manualNotes": "Trace bounds, UTF-8 handling, exclusion tests, AppState activity removal, and successful tool-result correlation are explicitly covered, but the findings above require plan revision."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 4m 21s (Total time 4m 20s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v5.md
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