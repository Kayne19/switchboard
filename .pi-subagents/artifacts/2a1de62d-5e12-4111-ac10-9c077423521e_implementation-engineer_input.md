# Task for implementation-engineer

Complete approved plan_v11 after `impl_delivery`. Implement and test unavailable-catalog provider-qualified model passthrough, thinking suffix preservation, populated-catalog picker compatibility, browser playback/outbox/picker race fixes, exact extension delivery error behavior, and required README/concurrency/observability/migration documentation. Update committed static output when web sources change. Preserve legacy tree and homelab boundary. Run focused Rust, Node, and documentation-adjacent tests; do not broaden scope.

## Context from phase 'impl_delivery'
# Handoff Output: impl_delivery
Status: success
Verdict: (none)
Timestamp: 1786011898

## Content
# Delivery implementation

Implemented the approved delivery slice without editing `legacy/` or homelab.

Highlights:

- Added registered WebSocket delivery epochs, a bounded per-connection writer queue, snapshot barrier ordering (`epoch`, `status`, `history`, optional `diagram`), ordered event sequence numbers, ping/errors/audio through the writer, and own-epoch retirement.
- Hardened audio reservations with bounded capacity and cancellation/release paths; stale synthesis no longer wedges later audio.
- Added one bounded speech deadline (default 25,000 ms, max 120,000 ms) through `Speaker`, HTTP TTS transport checks, process speech, normal reply synthesis, project agent environment, and extension `AbortSignal.timeout`.
- Browser reconnect waits for the epoch snapshot before retrying and removes clips invalidated by a new epoch.
- Tool speech is correlated by `toolCallId` and only suppresses written fallback after a matching successful `tool_execution_end`.
- Added bounded UTF-8-safe process diagnostic trace with 256-entry retention and 2 KiB serialized payload cap.
- Documented `SWITCHBOARD_SPEECH_DEADLINE_MS`; rebuilt committed `static/app.js`.

Changed files: `README.md`, `extensions/agent-switchboard.ts`, `src/api.rs`, `src/audio.rs`, `src/diagnostic.rs`, `src/lifecycle.rs`, `src/main.rs`, `src/pbx.rs`, `src/pi_client.rs`, `web/app.ts`, `static/app.js`.

Checks passed:

- `cargo fmt --all`
- `cargo test --locked` (68 tests)
- `cargo clippy --locked --all-targets -- -D warnings`
- `python3 -m unittest discover -s legacy/tests` (143 tests)
- `npm test`
- `git diff --check`

Residual risks: external browser timing, real TTS latency/cancellation, and homelab deployment contract remain environment-dependent. Pre-existing untracked `.pi-workflow/` and `.pi-subagents/` artifacts were not touched or staged.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Rust delivery, speech, correlation, diagnostics, and browser reconnect changes are scoped to the requested running service and extension paths; legacy and homelab were not edited."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "68 Rust tests, clippy, 143 legacy compatibility tests, npm/browser tests, formatting, and diff checks passed. Focused tests cover delivery registration, audio cancellation, bounded diagnostics, and matching successful speech tool ends."
    }
  ],
  "changedFiles": [
    "README.md",
    "extensions/agent-switchboard.ts",
    "src/api.rs",
    "src/audio.rs",
    "src/diagnostic.rs",
    "src/lifecycle.rs",
    "src/main.rs",
    "src/pbx.rs",
    "src/pi_client.rs",
    "web/app.ts",
    "static/app.js"
  ],
  "testsAddedOrUpdated": [
    "src/api.rs",
    "src/audio.rs",
    "src/diagnostic.rs",
    "src/pi_client.rs"
  ],
  "commandsRun": [
    {"command":"cargo fmt --all","result":"passed","summary":"Formatting clean"},
    {"command":"cargo test --locked","result":"passed","summary":"68 tests passed"},
    {"command":"cargo clippy --locked --all-targets -- -D warnings","result":"passed","summary":"No warnings"},
    {"command":"python3 -m unittest discover -s legacy/tests","result":"passed","summary":"143 tests passed"},
    {"command":"npm test","result":"passed","summary":"TypeScript build and browser/extension tests passed"},
    {"command":"git diff --check","result":"passed","summary":"No whitespace errors"}
  ],
  "validationOutput": [
    "WebSocket registration queues live events until the ordered snapshot writer completes.",
    "Stale browser clips are removed before reconnect retry after an epoch update.",
    "Canceled audio reservations release subsequent queued speech.",
    "Written fallback remains active unless a matching toolCallId end reports isError false.",
    "Diagnostic records are capped at 256 entries, 128 characters per field, and 2 KiB payloads."
  ],
  "residualRisks": [
    "Real browser media timing and external ElevenLabs cancellation still require deployment/hardware validation.",
    "The homelab deployment must carry the documented deadline variable in its separate PR."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added epoch-barriered single-writer WebSocket delivery, cancelable bounded audio reservations, one speech deadline, stale reconnect filtering, tool speech correlation, and bounded diagnostics with focused tests.",
  "reviewFindings": ["No blockers found in the repository checks."],
  "manualNotes": "Pre-existing .pi-workflow/ and .pi-subagents/ artifacts remain untracked and were not modified."
}
```


---
**Output:**
Write your findings to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/impl_compat.md
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