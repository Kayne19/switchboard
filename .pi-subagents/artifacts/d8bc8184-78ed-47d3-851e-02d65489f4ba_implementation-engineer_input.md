# Task for implementation-engineer

Continue the approved plan_v11 after `impl_lifecycle`. Inspect the current working tree and implement candidate/adoption and stale-work slices: CandidateLeg and ExtensionStageTxn rollback, per-process leg-token callback validation, controlled session_start thinking staging, candidate side-effect rejection, quiescing, rescue/idle/shutdown Coordinator paths, stale prompt/turn/clip barriers, and fail-closed SSH same-session redial with centralized SSH target validation across every caller. Preserve Pi JSONL and existing HTTP callback bodies. Add deterministic tests for adoption failure, staging cleanup, callbacks, stale work, idle/shutdown, and remote_shutdown_unverified. Do not edit legacy or homelab. Run focused checks.

## Context from phase 'impl_lifecycle'
# Handoff Output: impl_lifecycle
Status: success
Verdict: (none)
Timestamp: 1786009957

## Content
# Slice 1 implementation

Implemented the Rust lifecycle/coordinator seam and wired API generation/status reads through it without changing wire shapes.

- Added `src/lifecycle.rs` with `CallLifecycle`, `Coordinator`, `LegIdentity`, generation-aware `OperationIdentity`, phases, candidate startup state, immutable `StatusProjection`, and generation-matched `CatalogPublication`.
- Added short synchronous linearization methods for prompt begin/finish, steer attachment to the active prompt operation, callback acceptance, rescue generation advancement, candidate startup thinking/adoption, status publication, and shutdown.
- Replaced `AppInner`'s cached status/generation ownership with `Coordinator`; existing API stale-work checks and epoch snapshots now use coordinator generation.
- Added focused lifecycle tests for operation identity sharing, stale generations, candidate thinking privacy/adoption, catalog publication matching, rescue reopening, and status lock liveness.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Rust-only slice implemented in src/lifecycle.rs, src/api.rs, and src/main.rs; existing HTTP/WebSocket payload paths remain unchanged."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Focused lifecycle, stale-generation, catalog, operation, and status-lock tests pass, along with all existing Rust tests."
    }
  ],
  "changedFiles": [
    "src/lifecycle.rs",
    "src/api.rs",
    "src/main.rs"
  ],
  "testsAddedOrUpdated": [
    "src/lifecycle.rs (focused coordinator/status/lock tests)",
    "src/api.rs (generation test calls migrated to Coordinator)"
  ],
  "commandsRun": [
    {
      "command": "cargo fmt --all -- --check",
      "result": "passed",
      "summary": "Formatting clean"
    },
    {
      "command": "cargo test --locked",
      "result": "passed",
      "summary": "60 tests passed"
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "passed",
      "summary": "No warnings"
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors"
    }
  ],
  "validationOutput": [
    "Steer returns the same OperationIdentity as the active prompt operation.",
    "Rescue increments generation and stale operations/callbacks are rejected.",
    "Candidate startup thinking remains private until adoption.",
    "Catalog status is published only when project and generation match.",
    "Status reads do not wait on lifecycle linearization."
  ],
  "residualRisks": [
    "Switchboard still owns legacy route/session mirrors during this migration slice; later slices must complete ownership removal.",
    "The existing operation_transition and PBX/resource paths remain transitional and still need the planned full lock-order migration.",
    "No SSH, browser, TTS, or diagnostic-contract work was included in slice 1."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added coordinator lifecycle foundation and moved API status/generation reads and prompt/steer operation bookkeeping onto it.",
  "reviewFindings": [
    "No blockers found in focused Rust validation."
  ],
  "manualNotes": "Untracked .pi-workflow/.pi-subagents artifacts were pre-existing runtime outputs and were not edited or staged."
}
```


---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/impl_adoption.md
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