# Task for plan-reviewer

Perform a strict final adversarial review of plan_v8. Read the complete plan and all prior review handoffs as needed. Check its completeness matrix row by row against the repository. Reject any vague 'preserve', omitted caller, duplicate authority, unsafe lock claim, unspecified lock order, missing socket/queue lifecycle, candidate side effect, stale speech fallback, status cache, model passthrough, wire compatibility, or test gap. Prefer a simpler fail-closed design over an unprovable filesystem/security guarantee. This is the final gate: end exactly with `VERDICT: APPROVE` or `VERDICT: REVISE`.

## plan_v8
# Handoff Output: plan_v8
Status: success
Verdict: (none)
Timestamp: 1786006880

## Content
# plan_v8

## Scope and constraints

Revise only Rust, TypeScript extension, browser tests, and Rust tests. Do not edit `legacy/`, deployment, secrets, or homelab files. Preserve sentinel/RPC behavior, written transcript behavior, no durable queue/database, reconnect ordering, and the homelab boundary.

## Ordered implementation plan

1. **Make lifecycle ownership singular.**
   - In `src/pbx.rs`, introduce `CallLifecycle` and an independent `Coordinator`.
   - `CallLifecycle` alone owns route, project, persistent session ID, per-process leg token, generation, phase (`Operator`, `Candidate`, `Active`, `Quiescing`), requested/effective model and thinking, and activity clock.
   - Remove lifecycle mirrors from `Switchboard`, `AppInner`, `LiveLegState`, `status_snapshot`, `active_session`, `activity_clock`, `turn_generation`, and `operation_transition`.
   - `Switchboard` retains immutable configuration, registry, catalog provider/cache, extension staging, adapters, and process-resource/session management. `CandidateLeg` owns candidate processes and private startup state.
   - API owns only HTTP/WebSocket tasks, queues, connection epochs, audio reservations, transcript projection, and diagram projection.
   - `DiagnosticTrace` in new `src/diagnostics.rs` owns the process-global diagnostic ring and sequence; lifecycle only submits sanitized records.

2. **Define the lock and linearization model before moving callers.**
   - `Coordinator` has a short-lived lifecycle lock `C`; `DeliveryState` has delivery lock `D`; the PBX `Switchboard` mutex is `P`.
   - The only lock order is `C -> D`. Never acquire `P` while holding `C` or `D`; never acquire `C` or `D` from code holding `P`.
   - `/status`, `/leg-state`, `/speak`, and activity callbacks read or submit through `C` without acquiring `P`, so they remain live while a turn owns `P`.
   - Every rescue, transfer, redial, return, and hangup performs one coordinator transaction: under `C`, mark the old leg `Quiescing`, advance generation, and under `D` cancel/finalize reservations for the old generation; publish the new lifecycle only after process/adoption work succeeds.
   - `finish_audio` and every callback validate under `C`, then finalize under `D`; no callback can pass validation between quiescing and generation cancellation.
   - Tests in `src/api.rs` and `src/pbx.rs`: wedged-turn `/speak`, `/leg-state`, `/status`, hangup, rescue, and delivery tests with timeout assertions; lock-order tests prove no cycle.

3. **Make every asynchronous commit identity-checked.**
   - Define `LegIdentity { token, generation }` and `OperationIdentity { leg, operation_id }`.
   - `PiSession::start`, `prompt`, `steer`, callback registration, `/leg-state`, `/speak`, and `/diagram` carry the real per-process leg token, not the persistent session ID.
   - `extensions/agent-switchboard.ts` sends `{token, generation, operation_id, toolCallId}` where applicable. `toolCallId` is the operation identity for `speak` and `diagram`; session thinking reports use a deterministic session operation ID.
   - Extend `PiSession::prompt` and `steer` JSONL commands with exact `generation` and `operation_id` fields. The extension receives these through the Pi extension command context and includes them in callback requests; do not rely on process environment alone for per-operation data.
   - Validate identity immediately before every route, session, transcript, history, audio, diagram, status, and activity commit, including after each awaited STT, prompt, steer, TTS, callback, process-close, and intro operation.
   - Reject `Quiescing`, stale token, stale generation, unknown operation, and candidate public callbacks with no external side effect. Late internal activity may be diagnostic-only, never lifecycle activity.
   - Tests cover every endpoint and every awaited commit, including stale work racing transfer, redial, rescue, timeout, and disconnect.

4. **Implement transactional candidate adoption and safe redial.**
   - `transfer` and new-session `redial` create `CandidateLeg` with private process, token, generation, and bounded startup-result channel. Candidate route/project/model/session fields remain unpublished.
   - Candidate `speak`, `diagram`, activity, status, and leg-state effects are rejected with a bounded tool error, except effective thinking, which is privately staged and committed only during adoption.
   - Adoption occurs only after startup and intro succeed and identity is revalidated under `C`; then commit route, project, session ID, token, model, effective thinking, phase, status, and diagram reset atomically.
   - For same-session redial, mark the old leg `Quiescing`, cancel work, explicitly close and reap the local SSH child, send remote shutdown and wait for remote acknowledgement/SSH exit, then perform a bounded remote lock-release probe before starting the replacement. Failure to prove release returns to operator and never starts a second same-session process.
   - Lock-busy, exit 75, invalid-lock, startup, prepare, extension staging, and intro failures discard candidate state. Same-session redial settles to operator because the old leg was intentionally closed; new-session transfer/redial preserves the old authoritative leg until candidate adoption.
   - Tests in `src/pbx.rs`: candidate callback invisibility, staged thinking adoption, failed intro rollback, rescue during setup, same-session close/reap ordering, remote lock-busy/exit-75 settlement, and no partial route/model/session publication.

5. **Centralize SSH construction and secure remote locking.**
   - In `src/pi_client.rs`, add `validate_ssh_inputs`, `validated_ssh_argv`, `validate_env_name`, `remote_lock_script`, `lock_directory`, and `open_lock_file`; return `Result` for all validation and construction errors.
   - Route `remote_argv`, `list_models_argv`, `src/pbx.rs::run_prepare`, and `upload_extension_with` through the same validated SSH builder. Use `--` before the host, reject option-like hosts, NUL/control characters, oversized host/cwd/runtime/command/identity values, and invalid POSIX environment names. Shell-quote every remote value and argument.
   - Use a fixed secure lock root, opened once as a directory FD with owner `effective_uid`, mode `0700`, directory type, and no symlink. Do not perform per-acquisition `mkdir -p` or path checks.
   - Acquire the key atomically with `openat(root_fd, key, O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600)`; an existing entry is opened with `O_NOFOLLOW`, checked by FD, and locked with nonblocking `flock`. Hold the FD through `exec` as fd 9. Never chmod, follow, replace, or adopt a mismatched entry.
   - The filesystem invariant is explicit: the validated root FD is the authority, all lock use after acquisition is FD-relative, the final creation is atomic, and no later pathname lookup is used. Unix DAC cannot defend against a malicious same-UID process replacing the trusted root, so root ownership/mode validation is fail-closed and that threat is outside the cooperative-client model.
   - Propagate `Result` through `start_agent`, prepare, catalog loading, and staging. Operational staging failure may retain the documented sentinel fallback; validation and lock errors cannot silently fall back to unsafe SSH.
   - Tests cover invalid env names, controls, bounds, shell metacharacters, leading-dash hosts, every SSH caller, symlink/replacement/alias/root-mode/owner cases, atomic create contention, lock reuse, exit 75, and no runtime invocation after failure.

6. **Make speech delivery acknowledged, cancellable, and ordered.**
   - Replace `AudioQueue` with `DeliveryState` and `AudioReservation` containing generation, connection epoch, sequence, cancellation token, deadline, and one terminal state.
   - `ConnectionRegistry` allocates monotonically increasing WebSocket epochs, owns the exact bounded writer queue for each connection, replaces and disconnects epochs atomically, and cancels all reservations targeting retired epochs.
   - `/speak` captures `LegIdentity` and current connection epoch, writes the spoken transcript immediately, reserves audio, and awaits a bounded completion oneshot. It returns `delivered:true` only after the exact connection queue accepts the combined audio frame; `Full`, disconnect, stale identity, cancellation, deadline, worker failure, and no connection return `delivered:false` with a reason and emit `audio_delivery_failed`.
   - Use one documented end-to-end speech deadline for extension fetch, HTTP handler, TTS, queue acceptance, and oneshot. AbortSignal cancellation, request-drop cancellation, worker cancellation, and reservation cancellation propagate through the same token. The final reservation check and queue insertion occur atomically under `C -> D`; late TTS results cannot emit.
   - Queue-full disconnects/finalize reservations and advance ordered slots so later audio cannot wedge. Duplicate finalization is ignored. Written replies are never suppressed by failed or timed-out speech.
   - `Turn::agent_spoke` counts only a `speak` whose matching `tool_execution_end` has the same `toolCallId` and reports success/delivery. Failed or timed-out speech leaves ordinary written-reply fallback enabled.
   - Tests in `src/api.rs` and `tests/`: successful acknowledgement, TTS failure fallback, deadline-versus-commit race, cancellation during TTS, queue full, replaced socket, disconnect, lag, duplicate finalization, no late audio, no duplicate audio, and written fallback preservation.

7. **Preserve wire, reconnect, sentinel, and compatibility contracts.**
   - Keep `epoch -> status -> history -> diagram` snapshot ordering, broadcast lag recovery, clip generation stamping at recording start, accepted-clip idempotency, and ephemeral one-caller behavior.
   - Route all browser output through the exact connection writer; lagged JSON receives a fresh snapshot, while uncommitted audio reservations are canceled rather than replayed.
   - Keep `RETURN_SENTINEL`, legacy JSONL RPC commands, operator recovery, extension-unavailable sentinel fallback, and existing written transcript events.
   - Document new token/generation/operation fields as application contracts in the Rust/TypeScript migration docs. State explicitly that deployment requires a separate homelab PR and pinned-tag cutover.

8. **Make status, diagnostics, and model projection fresh and separately owned.**
   - `CallLifecycle::status_projection` and `api::current_status` query current coordinator state and catalog state at call time. `publish_status` and `emit_status_projection` accept no caller-supplied cached `Value`; they query fresh state immediately before emission.
   - Route callbacks become invalidation signals, not status snapshots. `/status`, health, reconnect snapshots, leg-state acceptance, and page replies all use the same fresh projection.
   - `DiagnosticTrace` is process-global, bounded to 256 records, sequence allocation and insertion are one mutex transaction, fields are sanitized by allowlist, UTF-8-safe capped at 128 bytes, and serialized records at 2 KiB. Exclude tokens, prompts, transcripts, stderr, paths, secrets, and raw tool arguments.
   - In `src/models.rs::ModelCatalog::resolve`, unavailable catalogs pass through provider-qualified model specs with normalized thinking and reject bare names. Add regression coverage matching `legacy/backend/models.py`.
   - Tests cover fresh status after lifecycle mutation, stale cached-value rejection, status ordering, reconnect projection, one-caller diagram ephemerality, concurrent diagnostic sequence uniqueness, eviction, UTF-8 truncation, payload bounds, sanitization, unavailable provider-qualified passthrough, bare-name refusal, legacy sentinel/RPC behavior, and homelab documentation boundaries.

## Ownership matrix

| Concern | Sole owner and call path | Invariant | Slice-local deterministic test |
|---|---|---|---|
| Lifecycle | `CallLifecycle` via `Coordinator::{transition,adopt,query}` from `src/pbx.rs`; API endpoints call coordinator, never PBX state mirrors | Route/project/session/token/generation/phase/model/thinking/activity have one authority | `src/pbx.rs`, `src/api.rs`: concurrent rescue, status, callback, and turn tests |
| Delivery | `DeliveryState::{reserve,commit,cancel}` in `src/api.rs` | No lifecycle generation is stored as current; reservations use captured identity only | Queue full, stale generation, duplicate finalization, and ordering tests |
| Diagnostics | `DiagnosticTrace::{record,snapshot}` in `src/diagnostics.rs` | Process-global bounded ring and sequence are independent of lifecycle | Concurrent sequence, eviction, UTF-8, sanitization tests |
| Processes | `CandidateLeg` and session management in `src/pbx.rs`/`src/pi_client.rs` | Candidate resources are private; same-session replacement starts only after close/reap/remote release | Adoption, remote shutdown, lock contention, intro failure tests |
| Configuration/catalog/staging | `Switchboard`, `ModelCatalog`, SSH/staging helpers | Immutable config/catalog identity is not lifecycle state; staging errors cannot create unsafe commands | Catalog, staging, validation, and provider passthrough tests |
| Transport | API connection registry, bounded queues, WebSocket tasks, audio projection | Exact connection epoch accepts delivery; replacement/disconnect cancels old reservations | Reconnect, lag, queue-full, no-late-audio tests |

## Rejected alternatives

- Keeping route, generation, token, activity, or status mirrors in `AppInner`, `DeliveryState`, or `LiveLegState`.
- Holding the coordinator or delivery lock across PBX turns, TTS, SSH, callbacks, or broadcaster sends.
- Publishing candidate route/status/speech/diagram/activity before adoption.
- Starting a same-session replacement before remote shutdown and lock release.
- `mkdir -p`, pre-check-then-open, `test -L`, pathname rechecks, or owner/mode checks presented as race proofs.
- `receiver_count()` as delivery acknowledgement, unbounded queues, durable audio storage, databases, Redis, or homelab edits.
- Counting `tool_execution_start` as successful speech.
- Passing cached status `Value` objects into publication helpers.
- Rejecting all candidate thinking without private startup staging.
- Treating callback identity as authentication; it is correlation and stale-work protection only.

## Acceptance commands

```text
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm test
git diff --exit-code -- static
```

External host risks only: live SSH/Pi shutdown behavior and filesystem administration, real Pi extension-context propagation, ElevenLabs/STT timing and cancellation, and the separate homelab deployment/cutover PR.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The plan assigns exact owners, call paths, lock order, lifecycle phases, candidate adoption rules, callback identities, SSH construction, audio epochs, status projection, diagnostics, model compatibility, and slice-local tests."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository and artifact inspection",
      "result": "passed",
      "summary": "Inspected plan_v7, review through review_v7, source symbols, extension paths, browser protocol, README, and concurrency hazards."
    },
    {
      "command": "cargo fmt --all -- --check; cargo test --locked; cargo clippy --locked --all-targets -- -D warnings; python3 -m unittest discover -s legacy/tests; npm test; git diff --exit-code -- static",
      "result": "not-run",
      "summary": "Implementation and verification belong to the implementation phase."
    }
  ],
  "validationOutput": [
    "All prior review findings are explicitly closed in ordered mechanisms rather than preservation claims.",
    "The replacement-race strategy states the trusted root-FD kernel/filesystem invariant and does not claim ordinary path checks prove safety.",
    "Every SSH caller is routed through ce

[Handoff 'plan_v8' truncated; full output: /home/kayne19/projects/switchboard/.pi-workflow/handoffs/wf_1786002388285300339_3730916_0/plan_v8.md]

## review_v7
# Handoff Output: review_v7
Status: success
Verdict: REVISE
Timestamp: 1786006589

## Content
# Adversarial review

1. **High: lock replacement-race proof is still insufficient.**  
   `src/pi_client.rs` has no current lock implementation. The proposed `mkdirat` then `openat` sequence can accept a same-owner, same-mode directory substituted between those calls: `fstat` and `fstatat` then agree on the replacement. The stated checks and tests do not prove rejection. Use an atomic identity-preserving creation strategy or explicitly define the kernel-level invariant.

2. **High: host validation does not cover every SSH caller.**  
   Plan step 2 scopes validation to `remote_argv`, but `list_models_argv` at `src/pi_client.rs:753-766`, prepare at `src/pbx.rs:~605`, and extension staging at `src/pbx.rs:985-996` construct SSH commands separately. A leading-dash or control-character host can still reach those paths. Centralize validated SSH argument construction and test every caller.

3. **High: coordinator locking can regress nonblocking callbacks.**  
   `/speak`, `/leg-state`, and `/status` must remain live while the turn holds the PBX mutex (`src/api.rs:455-460`, tests around `1486-1525`). Plan step 1 does not define whether the new coordinator lock is independent, nor a global lock order between coordinator, lifecycle, and delivery locks. A naïve implementation deadlocks or blocks callbacks.

4. **High: candidate external side effects remain ungated.**  
   Private thinking staging only addresses `report_leg_state`. Candidate `speak` and `diagram` callbacks currently have external effects (`extensions/agent-switchboard.ts:99-106,192-200`; `src/api.rs:833-890,900-906`). The plan must reject or privately stage all candidate callbacks, including activity, speech, diagrams, and status publication, until adoption.

5. **High: redial/process settlement requirements are not explicit.**  
   Step 1 does not require the old same-session process to be fully closed and reaped before starting a candidate, nor specify lock-invalid/exit-75 settlement back to operator. “Transfer/redial” inclusion alone does not prevent partial route/model/session publication on startup failure (`src/pbx.rs:~1170-1264`).

6. **Medium: socket epoch ownership and reconnect cleanup are only asserted.**  
   The existing broadcast path has no exact-connection `try_send` (`src/api.rs:1030-1080,1261-1280`). The plan names connection identities but omits epoch allocation, replacement cleanup, disconnect cancellation, lag handling, and snapshot ordering. Without those mechanics, a reservation can target a replaced socket or remain pending.

7. **Medium: speech timeout/cancellation remains underspecified.**  
   `extensions/agent-switchboard.ts:99-106` times out at 30 seconds, while TTS also has bounded transport behavior. Plan step 4 says “timeout” but gives no shared deadline, cancellation propagation, or late-result rule, so a timed-out tool can still deliver audio and trigger fallback/duplicate speech.

8. **Medium: successful tool completion correlation is missing.**  
   `Turn::agent_spoke()` currently treats `tool_execution_start` as speech (`src/pi_client.rs:54-56,414-435`). Plan step 4 does not require correlating `toolCallId` with successful completion. A failed `/speak` can therefore suppress ordinary fallback speech, breaking prior RPC behavior.

9. **Medium: fresh status projection and catalog compatibility are not carried forward.**  
   `status_snapshot` remains a second mutable status authority (`src/api.rs:37,176-204,302-315`), but plan step 1 only says “publish” status. Also, unavailable catalogs currently reject provider-qualified passthrough in `src/models.rs:230-237`; the plan merely says preserve it and adds no implementation or regression test.

Residual risks: lifecycle deadlock, same-owner lock aliasing, stale/replaced socket delivery, candidate side effects, duplicate speech, redial partial state, and compatibility regressions.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Plan_v7 closes the six review_v6 topics at a high level, but does not concretely preserve all earlier lock, callback, redial, socket, speech, status, and compatibility invariants."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository and plan inspection",
      "result": "passed",
      "summary": "Inspected lifecycle, API, SSH, extension, model, browser, and concurrency paths."
    }
  ],
  "validationOutput": [
    "Found nine unresolved or insufficiently specified risks, including three high-severity security/lifecycle gaps."
  ],
  "residualRisks": [
    "Replacement-race acceptance in descriptor traversal",
    "Unvalidated SSH callers",
    "Coordinator lock blocking callbacks",
    "Candidate speech/diagram side effects",
    "Incomplete redial settlement",
    "Socket epoch replacement races",
    "TTS timeout duplicate delivery",
    "Missing tool completion correlation",
    "Stale status and unavailable-catalog compatibility"
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only adversarial review; no source changes.",
  "reviewFindings": [
    "high: src/pi_client.rs and plan step 3 - same-owner replacement can still be accepted",
    "high: src/pi_client.rs:753-766 and src/pbx.rs:985-996 - SSH host validation bypasses remain",
    "high: src/api.rs:455-460 - coordinator lock order/nonblocking behavior is unspecified",
    "high: extensions/agent-switchboard.ts:99-106,192-200 - candidate external callbacks remain ungated",
    "high: src/pbx.rs:~1170-1264 - close/reap and exit-75 redial settlement are not explicit",
    "medium: src/api.rs:1030-1080,1261-1280 - socket epoch lifecycle is asserted, not specified",
    "medium: extensions/agent-switchboard.ts:99-106 - timeout cancellation and late results are undefined",
    "medium: src/pi_client.rs:54-56,414-435 - tool completion correlation is omitted",
    "medium: src/api.rs:37,176-204 and src/models.rs:230-237 - status/catalog compatibility is not concretely preserved"
  ],
  "manualNotes": "The six review_v6 headings are named in plan_v7, but exact closure and preservation of earlier requirements cannot be confirmed."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 48s (Total time 3m 48s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/review_v8.md
Do not call contact_supervisor merely because no write-capable tool is available.
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

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
    },
    {
      "id": "criterion-2",
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