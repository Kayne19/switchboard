# Task for plan-reviewer

Adversarially review plan_v7 against review_v6 and the repository. Verify exact closure of all six findings: sole coordinator generation with atomic audio cancellation ordering; POSIX env and safe SSH-host validation; descriptor-relative no-follow lock creation with replacement-race proof; explicit queue-full delivery semantics; private candidate thinking-state staging without external callback side effects; and separate DiagnosticTrace ownership of process-global ring/sequence. Confirm all earlier lifecycle, callback, redial, status, speech, compatibility, and scope requirements remain intact. Read-only. End exactly with `VERDICT: APPROVE` or `VERDICT: REVISE`.

## plan_v7
# Handoff Output: plan_v7
Status: success
Verdict: (none)
Timestamp: 1786006352

## Content
# plan_v7

Revise only the Rust/extension implementation and tests; preserve legacy RPC/sentinel behavior, unavailable-catalog passthrough, redial intent, compatibility, no durable queue/database, and no homelab changes.

## Ordered implementation plan

1. **Lifecycle and generation authority**
   - In `src/pbx.rs`, make `CallLifecycle` the sole owner of `GenerationId`, phase, route, leg token, session identity, model, and thinking state.
   - Remove current-generation state from `DeliveryState`/`AppInner`; reservations retain only captured generation and connection identities.
   - Add one coordinator transaction used by `transfer`, `redial`, `return_operator`, `force_hangup`, and rescue: acquire coordinator lock, acquire `DeliveryState`, mark the old lifecycle quiescing, finalize/cancel all affected reservations, advance `CallLifecycle` generation, publish the new lifecycle, then release locks. `finish_audio` cannot commit while this transaction holds `DeliveryState`.
   - `reserve_audio` reads the generation from `CallLifecycle` through the coordinator. Every stale check uses the reservation identity, never a duplicated “current generation.”
   - Propagation: transition → reservation cancellation → generation advance → status/epoch publication; old callbacks and queued turns reject by captured identity.

2. **Remote command validation**
   - In `src/pi_client.rs::{remote_argv, validate_remote_inputs, validate_env_name}`, return `Result<Vec<String>, PiSessionError>`.
   - Validate before constructing any export: POSIX names must match `[A-Za-z_][A-Za-z0-9_]*`; names, values, host, session identity, command parts, and generated command have fixed byte limits; reject NULs and unsafe control characters with bounded, non-echoing errors.
   - Preserve `shell_quote` for values and command arguments. Metacharacters in values remain data; they are never interpolated unquoted.
   - Invoke SSH with an explicit `--` separator before the host so leading-dash hosts cannot become options. Preserve normal host behavior and session identity validation.
   - Propagate failures through `src/pbx.rs::start_agent` with `?`; never construct an unsafe fallback.
   - Tests in `src/pi_client.rs`: invalid names, NUL/oversized values, shell metacharacters, leading-dash host argument capture, normal host/command generation, and session identity rejection.

3. **Descriptor-relative lock safety**
   - In `src/pi_client.rs::{remote_lock_script, lock_directory, open_lock_file}`, use only descriptor-relative operations from an fd for `/`.
   - Traverse each component with `openat`/`os.open` using directory, close-on-exec, and no-follow flags. Create missing components with `mkdirat`/`os.mkdir` mode `0700`, then reopen them by descriptor.
   - Hold every ancestor fd through lock-file open. After each open, compare `fstat` of the held fd with `fstatat(..., AT_SYMLINK_NOFOLLOW)` for device, inode, type, uid, and exact mode. Any mismatch, symlink, replacement, ownership mismatch, or mode mismatch returns `remote_session_lock_invalid` and exit 75; do not retry or adopt the replacement.
   - Open the final lock by the held terminal directory fd with no-follow semantics. Require effective-user ownership and exact `0600`; never chmod or silently adopt an existing mismatch. `flock` contention returns `remote_session_lock_busy`, exit 75. Preserve fd 9 across `exec`.
   - Tests inject replacement at each traversal/open boundary and assert identity mismatch rejection and no runtime invocation; separately test pre-existing symlinks for every ancestor and lock file, wrong owner/mode, contention, and valid reuse. Do not claim owner/mode checks alone prove race safety.

4. **Audio saturation and delivery acknowledgement**
   - In `src/api.rs::{DeliveryState, AudioReservation, finish_audio, process_speech, speak, synthesize_reply_if_current}`, make queue-full behavior fail-and-report.
   - A reservation is committed only after the captured connection’s bounded `try_send` accepts the frame. `Full`, disconnected, stale-generation, timeout, and cancellation states finalize the reservation exactly once and can never produce `delivered:true`.
   - Add a per-request `oneshot` completion to `SpeechRequest`; `/speak` awaits the bounded completion result. Success returns `delivered:true` only after actual queue acceptance. Failure returns `delivered:false` with a bounded reason and emits a written `audio_delivery_failed` event. The transcript/spoken text remains written; no durable audio fallback is introduced.
   - Normal agent speech reports the same failure through the error event. No `receiver_count` shortcut remains.
   - Tests in `src/api.rs` cover queue-full, disconnected writer, successful acknowledgement, duplicate-finalization prevention, and written fallback/error response.

5. **Candidate effective-thinking staging**
   - In `src/pbx.rs`, give `CandidateLeg` a private bounded startup-result channel containing validated effective thinking.
   - Candidate startup callbacks may write only to this channel after token validation; they cannot mutate `CallLifecycle`, status snapshots, route, or active-leg state. Public `report_leg_state`/`/leg-state` callbacks remain rejected while phase is `Candidate`.
   - `start_agent` and intro handling consume the staged startup result only during the adoption transaction. Adoption commits the staged effective thinking; startup failure drops it and returns to the operator without exposing candidate state.
   - Tests cover callback before adoption, adoption preserving `thinking` and `thinking_confirmed`, callback invisibility during candidate phase, failed startup discarding staged state, and stale-token rejection.

6. **Diagnostics authority**
   - Add `src/diagnostics.rs::{DiagnosticTrace, DiagnosticRecord}`. `main.rs` creates one process-global `Arc<DiagnosticTrace>` and passes it to `CallLifecycle`/application state.
   - `DiagnosticTrace` exclusively owns the synchronized 256-entry ring, monotonic sequence, retention, UTF-8-safe 128-byte field limits, 2 KiB serialized payload limit, and sanitization allowlist. Sequence allocation and ring insertion occur under one mutex.
   - `CallLifecycle` only emits bounded records through `DiagnosticTrace`; it owns neither the counter nor ring.
   - Tests cover concurrent unique monotonic sequencing, 256-entry eviction, byte-safe truncation, payload bounds, and removal of tokens, prompts, transcripts, stderr, paths, secrets, and raw tool arguments.

## Ownership and propagation

| Owner | Owns | Must not own |
|---|---|---|
| `CallLifecycle`/coordinator | Current generation, phase, route, leg identity, model/thinking | Audio queues, process handles, global diagnostics |
| `DeliveryState` | Reservations, captured identities, queue state, terminal outcomes | Current generation |
| `CandidateLeg` | Candidate process and private startup staging | Published lifecycle/status |
| `DiagnosticTrace` | Global sequence, ring, sanitization, retention | Lifecycle transitions |
| API/WebSocket state | Connection epochs, writers, acknowledgements | PBX lifecycle mirrors |
| `PiSession` remote helper | Validated argv and descriptor-held lock | Lifecycle adoption decisions |

## Rejected alternatives

- Keeping a generation mirror in `DeliveryState`.
- Checking paths with `mkdir -p`, `test -L`, ordinary opens, or owner/mode checks alone.
- Returning `delivered:true` from receiver presence before queue acceptance.
- Buffering candidate callbacks in public lifecycle state.
- Storing the global diagnostic ring or sequence in `CallLifecycle`.
- Durable audio queues, databases, Redis, or homelab edits.

## Acceptance checks

Run:

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
      "evidence": "Plan_v7 assigns exact owners, transaction ordering, validation rules, descriptor identity checks, queue outcomes, candidate staging, diagnostic synchronization, deterministic tests, and file/symbol mappings for all six review findings."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository inspection and plan revision",
      "result": "passed",
      "summary": "No source files were edited."
    },
    {
      "command": "cargo fmt --all -- --check; cargo test --locked; cargo clippy --locked --all-targets -- -D warnings; python3 -m unittest discover -s legacy/tests; npm test; git diff --exit-code -- static",
      "result": "not-run",
      "summary": "Implementation and verification belong to the executing implementation phase."
    }
  ],
  "validationOutput": [
    "All six review_v6 findings have explicit mechanisms, ownership boundaries, propagation paths, and deterministic tests."
  ],
  "residualRisks": [
    "Live SSH, TTS, browser scheduling, and homelab deployment remain external validation surfaces."
  ],
  "noStagedFiles": true,
  "diffSummary": "Planning-only revision; no source changes.",
  "reviewFindings": [
    "closed high: generation authority and transition/audio ordering",
    "closed high: POSIX environment validation and option-safe SSH host handling",
    "closed high: descriptor-relative no-follow traversal with identity checks and fail-closed replacement handling",
    "closed medium: bounded audio queue saturation and acknowledgement semantics",
    "closed medium: private candidate thinking staging with adoption-only commit",
    "closed medium: separate process-global DiagnosticTrace authority"
  ],
  "manualNotes": "No unresolved ambiguity remains for the six review_v6 findings."
}
```

[38;2;136;136;136m✻ Turn took 3m 51s (Total time 3m 50s · 1 turn)[0m

## review_v6
# Handoff Output: review_v6
Status: success
Verdict: REVISE
Timestamp: 1786006066

## Content
# Adversarial review

1. **High: lifecycle generation has two authorities.**  
   Slice 1 assigns generation to `CallLifecycle`, while slice 5 makes `DeliveryState` own the current generation. Slice 2 advances it under the coordinator lock, then cancels audio separately. A `finish_audio` can interleave between those operations and observe inconsistent state. Make generation coordinator-owned and define one lock/order transaction for lifecycle advancement plus reservation cancellation.

2. **High: remote command validation leaves injection/option risks.**  
   `src/pi_client.rs:795-850` currently emits `export {name}=...` and passes `host` as an SSH argument. Plan_v6 only rejects NULs and bounds lengths. Invalid environment names can alter shell parsing, and option-like hosts can be interpreted as SSH options. Require POSIX environment-name validation and safe host argument handling, with tests.

3. **High: descriptor algorithm does not prove replacement-race rejection.**  
   `mkdirat` followed by `openat(O_NOFOLLOW)` and owner/mode checks can accept a different same-owner, mode-0700 directory substituted between operations. The plan claims replacement races are rejected but specifies no inode/identity verification. Clarify and test the required invariant.

4. **Medium: bounded `try_send` can silently lose committed audio.**  
   `finish_audio` marks a reservation ready and drains it, then `try_send`s to a bounded queue. Queue-full behavior is unspecified; `/speak` may already have returned `delivered:true`. Define whether full queues cancel, block, or report failure, and test it.

5. **Medium: candidate callback rejection loses effective thinking state.**  
   `extensions/agent-switchboard.ts` reports thinking during `session_start`, before candidate adoption. Since plan_v6 rejects all Candidate callbacks and forbids buffering, the new leg can become Active with `thinking_confirmed:false` permanently. Preserve this callback result through an explicit startup/adoption mechanism without exposing candidate state.

6. **Medium: diagnostics ownership contradicts process-global sequencing.**  
   Slice 1 puts lifecycle diagnostics inside `CallLifecycle`, while slice 8 requires a process-global 256-entry ring and monotonic sequence numbers. Store the ring/counter in a separate diagnostic service; lifecycle may only emit bounded records.

Existing v5 blockers are otherwise addressed: lock `Result` propagation and exit-75 settlement, atomic audio finalization intent, socket epoch capture/replacement cleanup, fresh status projection, and process/WebSocket ownership separation. Legacy sentinel/RPC behavior, unavailable catalogs, redial intent, and no homelab scope are explicitly retained, but the above ambiguities still permit security, delivery, and compatibility regressions.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "The five v5 blockers are addressed, but generation ownership, remote validation/race invariants, queue-full behavior, candidate callbacks, and diagnostics ownership remain underspecified."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Read-only inspection covered the plan, review_v5, src/api.rs, src/pi_client.rs, src/pbx.rs, extensions, browser protocol, and concurrency documentation."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository and plan inspection via read/grep",
      "result": "passed",
      "summary": "Read-only review; no source changes."
    }
  ],
  "validationOutput": [
    "Checked remote_argv callers, lifecycle mirrors, audio reservation paths, WebSocket protocol epochs, extension callbacks, and documented concurrency invariants."
  ],
  "residualRisks": [
    "Lifecycle/audio generation race",
    "Remote shell and SSH input validation gaps",
    "Directory replacement race",
    "Audio loss on bounded queue saturation",
    "Candidate effective-thinking callback loss",
    "Diagnostics ownership ambiguity"
  ],
  "noStagedFiles": true,
  "diffSummary": "No source changes; adversarial review only.",
  "reviewFindings": [
    "high: plan_v6 slices 1, 2, 5 - duplicated lifecycle-generation authority and incomplete cancellation ordering",
    "high: src/pi_client.rs:795-850 - environment-name and SSH-host validation are insufficient",
    "high: plan_v6 slice 3 - replacement-race rejection is asserted but not specified",
    "medium: plan_v6 slice 5 - bounded try_send queue-full behavior is undefined",
    "medium: plan_v6 slices 1-2 - Candidate startup callbacks can lose effective thinking",
    "medium: plan_v6 slices 1 and 8 - diagnostics ownership conflicts with process-global ring semantics"
  ],
  "manualNotes": "Review_v5 closure is substantial but not exact enough to approve."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 4m 30s (Total time 4m 30s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/review_v7.md
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