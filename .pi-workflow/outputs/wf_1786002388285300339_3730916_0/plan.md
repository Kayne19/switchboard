# Switchboard lifecycle migration plan

**Scope:** read-only plan; no source edits. Highest risks are P0 split ownership (`src/api.rs:30-54`, `src/pbx.rs:166-240`), non-atomic adoption (`src/pbx.rs:636-663`, `1248-1264`), and stale delivery (`src/pbx.rs:491-588`).

## Target state and ownership

1. Make `Switchboard` the sole `CallLifecycle` owner; do not add a parallel orchestration framework. Consolidate route, project, model, active/pending leg, session identity, generation, phase, and terminal outcome there.
2. Use phases `OperatorReady`, `ProjectPreparing`, `ProjectStarting`, `ProjectIntro`, `ProjectActive`, `TurnRunning`, `Returning`, `Redialing`, `Rescuing`, and `Shutdown`; failures are terminal outcomes that settle to `OperatorReady` or `Shutdown`, never a stranded project phase.
3. Represent identity as `{operation_id, generation, leg_id/session_token}`. Represent outcomes as `Succeeded`, `Failed{code}`, `Cancelled`, or `Superseded`.
4. Emit `LifecycleEvent {seq, operation_id, generation, leg_id, phase, kind, outcome, sanitized payload}`. `seq` is monotonic for process lifetime; the bounded journal is in-memory only.
5. `src/api.rs` validates HTTP/WebSocket commands, owns queues, task handles, audio ordering, and event broadcasting; it may request lifecycle commands but cannot mutate route or generation.
6. `src/pi_client.rs` owns JSONL/process/SSH mechanics only; `PiSession::{start,prompt,steer,close,same_session}` returns typed transport/tool outcomes and never changes routing.
7. `src/audio.rs`, `src/registry.rs`, `src/models.rs`, and `src/history.rs` remain task/value adapters; `web/` is a projection; extensions request actions only; `legacy/` remains compatibility baseline; homelab owns deployment and secrets.

## Ordered migration slices

1. **Trace seam, no behavior change:** add lifecycle types/events beside `Switchboard` in `src/pbx.rs`; route `announce_route` through an event callback; add exact trace tests to existing `fake_runtime()` tests. Preserve `Event::Json`, all HTTP/WS shapes, and snapshot order.
2. **Atomic leg adoption:** refactor `transfer`, `dial`, `set_model`/redial, `drop_agent`, and `start_agent` in `src/pbx.rs` to prepare a candidate, start it, then adopt route/project/model/session fields in one commit. On cancellation/failure close the candidate and settle to the prior valid leg or operator; never expose a project route without its adopted session.
3. **Canonical stale checks:** pass `OperationIdentity` through `handle`, `handle_agent`, transfer/redial, `process_turns`, `deliver_turn_if_current`, `deliver_page_reply_if_current`, and `synthesize_reply_if_current` in `src/api.rs`; re-check generation and `PiSession::same_session()` after every awaited prompt and before route, transcript, reply, or audio commit. Delete duplicate API generation mutation after coordinator ownership is proven.
4. **Journal and projection:** replace mutable status publication in `src/api.rs::{status_snapshot,publish_status,current_status}` with coordinator snapshot projection plus a bounded lifecycle journal/broadcaster. Serialize additive lifecycle events for WebSocket while retaining `epoch/status/history/diagram` reconnect ordering and existing browser messages.
5. **Normalize adapter outcomes:** extend `src/pi_client.rs::{Turn,Signal,collect}` to distinguish tool started/completed/failed; correlate `/speak`, `/diagram`, and `/leg-state` callbacks with session token and operation identity. Preserve sentinel return, JSONL protocol, and existing external payloads; fix failed-speak fallback only after compatibility tests pin the intended behavior.
6. **Coverage completion:** add deterministic tests in `src/pbx.rs` for transfer/redial adoption, intro failure, return, hangup, idle, shutdown, and stale prompts; in `src/api.rs` for rescue during STT/turn/transfer/redial, stale audio, WS snapshot/lagging, and endpoint cancellation; in `src/pi_client.rs` for terminal outcomes. Extend `tests/test_protocol.mjs`, `legacy/tests/test_pbx.py`, `legacy/tests/test_piclient.py`, and model compatibility tests.
7. **Documentation and deployment:** update `README.md`, `docs/concurrency-and-test-hazards.md`, `docs/observability-and-coverage-handoff.md`, and `docs/rust-typescript-migration-handoff.md` with phase/event ownership, bounded retention, ephemeral restart semantics, and `SWITCHBOARD_LOG`/`SWITCHBOARD_LOG_FORMAT`. Cut over only through a separate homelab pinned-tag PR; retain the Python tag and one-change rollback.

## Invariants, stop conditions, rejected alternatives

- No stale generation or leg identity may mutate route, transcript, reply, TTS, diagram, or status; every adopted child is closed on cancellation; every terminal event follows its operation’s start event.
- Stop and revert the current slice if any existing wire shape changes, a trace shows duplicate/non-monotonic sequence, a rescue leaves an orphan process, or any Rust/legacy/Node/static/Clippy gate fails.
- Rejected: Postgres/Redis leases, durable replay, React state, a universal FSM, new process traits, early Python deletion, and treating transcript history as lifecycle persistence; these add scope without single-caller product semantics.
- Unresolved for the parent: whether lifecycle events are public WS data or diagnostics only; exact journal retention/replay; restart durability and idempotency requirements; final phase vocabulary; whether failed `speak` fallback is in this migration; Rust/Python cutover timing and STT equivalence threshold.

## Validation contract

Run `cargo fmt --all -- --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, `python3 -m unittest discover -s legacy/tests`, `npm test`, and `git diff --exit-code -- static`; require exact traces for every listed success, failure, stale-work, rescue, and shutdown path, then perform homelab hardware/SSH/STT/TTS and rollback checks before deleting Python.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Plan names concrete severity-rated findings, exact files and symbols, target ownership, FSM states, event contracts, migration order, tests, deployment compatibility, rollback, and unresolved decisions."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository and handoff inspection",
      "result": "not-run",
      "summary": "Read-only planning; no tests or source changes."
    }
  ],
  "validationOutput": [
    "Defined a coordinator-first migration with compatibility-preserving slices and exact validation gates."
  ],
  "residualRisks": [
    "Public lifecycle-event exposure, durability, phase vocabulary, speak fallback scope, and deployment cutover remain parent decisions.",
    "Hardware, credentials, model quality, and rollback require homelab validation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; implementation plan only.",
  "reviewFindings": [
    "high: src/api.rs:30-54 and src/pbx.rs:166-240 - lifecycle ownership is split.",
    "high: src/pbx.rs:636-663,1248-1264 - leg adoption mutates visible state before startup succeeds.",
    "high: src/pbx.rs:491-588 - stale post-prompt session identity validation is absent.",
    "medium: src/api.rs:176-191,302-316 - status/events lack canonical ordered lifecycle trace."
  ],
  "manualNotes": "The plan deliberately excludes reference-specific durable infrastructure and premature legacy removal."
}
```

[38;2;136;136;136m✻ Turn took 2m 18s (Total time 2m 17s · 1 turn)[0m