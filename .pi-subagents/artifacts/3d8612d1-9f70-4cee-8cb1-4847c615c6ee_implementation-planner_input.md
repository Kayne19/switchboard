# Task for implementation-planner

Revise plan_v5 using review_v5. Close every remaining blocker with exact mechanisms, propagation paths, ownership table, and deterministic tests. Preserve all approved decisions and do not edit source files.

Required corrections:
1. Remote lock safety: specify race-safe no-follow creation/open semantics for every lock-directory ancestor and the lock file, strict owner/mode checks, symlink rejection, bounded path handling, and deterministic pre-existing-symlink tests. Because src/pi_client.rs::remote_argv currently returns Vec<String>, specify Result/error propagation through src/pbx.rs startup and immediate remote exit-75 lock-busy handling without unsafe adoption.
2. Speech/audio atomicity: define cancellation/deadline state and final AudioQueue slot commit as one serialized operation so a worker cannot pass a stale check and emit after cancellation. Specify timeout-versus-commit ordering, reservation finalization, and deterministic race tests proving no late audio or duplicate written fallback.
3. Socket epoch ownership: define where each WebSocket connection gets its epoch, how that epoch is attached to SpeechRequest/audio reservations, how disconnect/reconnect cancels only the old epoch, and how delivery is tied to the specific active connection rather than broadcast receiver_count. Add reconnect-during-TTS and replaced-socket tests.
4. Fresh status: remove caller-supplied Value status arguments from delivery/publication helpers such as src/api.rs::916-965. Require emit_status_projection to query CallLifecycle at emission time, with tests proving a newer lifecycle mutation cannot be followed by an older cached status.
5. Ownership boundary: add an explicit table separating CallLifecycle transition state, CandidateLeg/session process resources, Switchboard immutable configuration/catalog/staging/adapters, and API transport queues/WebSocket/audio/task registries. Explain how late internal activity callbacks from quiesced legs are rejected, without turning CallLifecycle into a god object.

End with exact file/symbol mapping, slice-local tests, acceptance commands, and no unresolved ambiguity for these blockers.

## Context from phase 'review_v5'
# Handoff Output: review_v5
Status: success
Verdict: REVISE
Timestamp: 1786005480

## Content
# Adversarial review

1. **High: remote lock placement is still not race-safe.**  
   The SHA-256 key closes aliasing, but checking “non-symlink directory” before `mkdir`/opening `<key>.lock` does not prevent symlink substitution. Every ancestor and the lock file need atomic no-follow creation/open semantics, strict ownership/mode checks, and a deterministic test for pre-existing symlinks. Also, `remote_argv` currently returns `Vec<String>` (`src/pi_client.rs:795`); the plan must specify `Result` propagation through `src/pbx.rs:738` and lock-busy detection when SSH starts then immediately exits 75.

2. **High: cancellation and final audio commit are not specified as one atomic operation.**  
   `finish_audio` currently checks generation before queue mutation (`src/api.rs:353-360`). A worker can pass a cancellation/deadline check, then acquire the queue lock after the handler cancels and still emit. The plan needs a cancellation/deadline barrier checked while committing the slot, plus a deterministic timeout-versus-commit race test. Otherwise “no late delivery” remains an assertion, not a guarantee.

3. **High: socket epoch ownership is undefined for `/speak`.**  
   `SpeechRequest` is described with generation and sequence but no socket epoch, while `speak` has no browser identity (`src/api.rs:863-895`). `broadcast::Sender::receiver_count()` only indicates subscribers, not that a particular browser received the frame. Define how the active WebSocket epoch is allocated, attached to a reservation/request, and safely cancelled when an old socket disconnects after a reconnect. Otherwise `cancel_epoch` can cancel the wrong request or stale reservations can survive.

4. **Medium: status projection can still be stale unless the API shape changes.**  
   Existing delivery helpers accept a precomputed `Value` (`src/api.rs:916-965`). The plan says to query fresh coordinator state, but does not explicitly remove that argument. Require `emit_status_projection` to query at emission time and never accept caller-supplied status; otherwise a same-generation operation can emit an older projection after a newer lifecycle mutation.

5. **Medium: ownership boundaries risk creating the promised god object.**  
   `CallLifecycle` is assigned route, project, session/token, generation, model/thinking, activity, diagnostics, and coordinator commands, while the plan says `Switchboard` becomes only a facade. It does not state where operator/agent processes, catalogs, staging, and callbacks live. Add an ownership table: lifecycle state/transition logic in `CallLifecycle`, process resources in `CandidateLeg`/session management, and configuration/catalog services outside lifecycle. Also gate late internal activity callbacks from quiesced legs.

The plan does explicitly close the callback phase requirement, candidate rejection, close-before-reopen ordering, tool completion correlation, and removal intent for the mutable status mirror. Those are not sufficient to offset the lock, commit-race, and socket-epoch gaps.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "The plan improves all five blockers but leaves secure no-follow lock creation, atomic speech cancellation/commit, and socket epoch ownership underspecified."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Repository symbols and concrete call paths were checked for remote_argv, speech processing, AudioQueue, WebSocket lifecycle, callback endpoints, and status projection."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection and read-only plan review",
      "result": "not-run",
      "summary": "No source changes or validation commands were performed."
    }
  ],
  "validationOutput": [
    "Reviewed src/pi_client.rs, src/api.rs, src/audio.rs, src/pbx.rs, extensions/agent-switchboard.ts, and README.md against plan_v5 and review_v4."
  ],
  "residualRisks": [
    "Symlink races and ambiguous ownership can invalidate remote lock safety.",
    "Cancellation can race final audio emission.",
    "A disconnected or replaced browser is not tied unambiguously to speech reservations.",
    "Status freshness and lifecycle ownership remain implementation-sensitive."
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only review; no repository changes.",
  "reviewFindings": [
    "high: src/pi_client.rs:795 and src/pbx.rs:738 - secure lock creation and Result/error propagation are incomplete.",
    "high: src/api.rs:353-390 - cancellation is not specified atomically with final audio commit.",
    "high: src/api.rs:863-895 - SpeechRequest/reservation has no defined socket epoch ownership.",
    "medium: src/api.rs:916-965 - stale status Value arguments can undermine fresh projection semantics.",
    "medium: plan_v5 slices 1-2 - lifecycle ownership boundaries are insufficient to rule out a new god object."
  ],
  "manualNotes": "Quiescing rejection, completed tool correlation, and status-mirror removal intent are otherwise explicit."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 4m 26s (Total time 4m 25s · 1 turn)[0m

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v6.md
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