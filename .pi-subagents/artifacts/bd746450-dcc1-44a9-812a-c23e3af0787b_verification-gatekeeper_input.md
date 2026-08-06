# Task for verification-gatekeeper

Verify the final worktree against approved plan_v11 and repository instructions. Inspect the diff and run: `cargo fmt --all -- --check`; `cargo test --locked`; `cargo clippy --locked --all-targets -- -D warnings`; `python3 -m unittest discover -s legacy/tests`; `npm test`; deterministic static rebuild and `git diff --exit-code -- static` with the intended static changes accounted for. Check no legacy or homelab files changed, no secrets, no staged files, and run focused race/protocol tests. Report exact commands/results, changed-file summary, residual external host risks, and a final verdict.

## Context from phase 'fix_impl'
# Handoff Output: fix_impl
Status: success
Verdict: (none)
Timestamp: 1786014336

## Content
# Root Cause Fix Implementation Report

## Summary of Fixes

All 8 concrete findings from `review_impl` have been resolved at their shared root cause:

1. **/speak delivery reporting (Blocker):**
   - Delayed `transcript_log.add` and `emit_json("spoken")` until after TTS synthesis and WebSocket delivery succeed.
   - Guaranteed `/speak` returns `delivered: false` with `"reason"` when TTS or WebSocket delivery fails.

2. **Redial candidate adoption (High):**
   - Refactored `redial` in `src/pbx.rs` to use `Coordinator::begin_candidate`, `start_agent`, candidate `prompt`, `adopt_candidate`, and `commit_staged_extension`.
   - Prevented premature dropping of the active leg before candidate startup completes.

3. **Rescue turn registration race (High):**
   - Updated `spawn_registered_operation` in `src/api.rs` to acquire `active_operations` lock prior to checking `coordinator.generation() == generation`.
   - Prevented spawning turn tasks when generation has bumped due to a rescue.

4. **Transactional candidate staging (High):**
   - Keyed extension staging by candidate token (`format!("{host}\0{candidate_token}")`).
   - Updated `commit_staged_extension` and `rollback_staged_extension` to operate on exact candidate keys, preventing deletion or reuse of shared artifacts on candidate failure.

5. **Callback active operation requirement (High):**
   - Enforced `state.operation.is_some()` and active phase checks in `accept_side_effect` for non-operator legs.

6. **Candidate startup thinking validation (Medium):**
   - Validated `THINKING_LEVELS` in `accept_startup_thinking` and `accept_thinking_callback` before storing candidate values.
   - Guaranteed `adopt_candidate` promotes startup thinking only when valid, falling back to `candidate.thinking`.

7. **Diagnostics context sanitization (Medium):**
   - Redacted raw prepare output logging in `src/pbx.rs` (logging `bytes` count).
   - Ensured `src/models.rs` model-listing warnings log `program` and `argc` without raw arguments.
   - Confirmed no full `argv` or system prompts are logged in `src/pi_client.rs`.

8. **Speech deadline validation (Medium):**
   - Updated `Pbx::new` in `src/pbx.rs` to panic on invalid `SWITCHBOARD_SPEECH_DEADLINE_MS`, matching `src/main.rs` and `src/audio.rs`.

## Validation

All acceptance gates pass cleanly:

- `cargo fmt --all -- --check`
- `cargo test --locked` (73 tests passed)
- `cargo clippy --locked --all-targets -- -D warnings`
- `python3 -m unittest discover -s legacy/tests` (143 tests passed)
- `npm test`
- `git diff --exit-code -- static`

## Residual Risks

- Integration with physical ElevenLabs TTS endpoint and actual remote SSH hosts remains subject to real network availability and credentials.


---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/verify_final.md
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