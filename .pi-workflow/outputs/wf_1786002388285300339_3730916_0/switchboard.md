# Current switchboard map

## Runtime call path

1. `src/main.rs:309-390` loads the env file, initializes tracing, loads `Registry`, constructs `Switchboard`, `AppState`, workers, idle watcher, Axum routes, static serving, and graceful shutdown.
2. Browser `web/app.ts:802-982` connects to `/ws`, receives `epoch/status/history/diagram`, records clips, and sends a JSON clip header followed by binary WebM. `src/api.rs:1018-1272` validates, deduplicates, acknowledges, and queues clips.
3. `process_clips` (`src/api.rs:400-531`) runs STT, checks the capture generation, persists/broadcasts the transcript, then steers the active `PiSession` or queues a turn.
4. `process_turns` (`src/api.rs:532-601`) serializes turn dispatch, calls `Switchboard::handle`, emits reply/status, and invokes TTS. `/speak` and `/diagram` bypass PBX turn serialization for mid-turn callbacks (`src/api.rs:833-913`).

## Ownership and lifetimes

| Data | Current owner and synchronization | Lifetime / forbidden responsibility |
|---|---|---|
| Route, project, operator/agent sessions, model/session IDs | `Switchboard` fields in `src/pbx.rs:166-240`, protected mainly by its `tokio::Mutex` in `AppState` | Process/call lifetime; transport should not decide routing |
| Active session and leg token | PBX-owned `Arc`s exposed through `session_control()` and `live_leg_state()` (`src/pbx.rs:268-280`) | Shared API rescue/steering boundary; duplicates route identity with `Switchboard.route` |
| Rescue and operation identity | `AppState.operation_transition`, `active_operations`, `turn_generation` (`src/api.rs:30-54`) | Turn/page-operation lifetime; PBX does not know generations |
| Queues and audio ordering | API channels plus `AudioQueue` (`src/api.rs:56-125`) | Process lifetime; audio is not durable |
| Status | PBX creates JSON; API retains mutable `status_snapshot` and republishes it (`src/api.rs:176-191,302-316`) | Current snapshot only, no ordered history |
| Transcript and diagram | `TranscriptLog` and `last_diagram` (`src/history.rs:31-101`, `src/api.rs:195-220`) | Bounded process memory; reconnect replay only, no restart durability |
| Child process / JSONL turn | `PiSession` (`src/pi_client.rs:74-475`) | One leg process; owns stdin/stdout/stderr, timeout, reaping, and parsing |
| STT/TTS | `SttAdapter` and `Speaker` (`src/audio.rs:104-353`) | Adapter boundary; no routing mutation |
| Registry and model catalog | `Registry` (`src/registry.rs:5-217`) and per-host catalogs cached in PBX (`src/pbx.rs:1109-1185`) | Configuration/process lifetime; registry is deployment-rendered |
| Browser UI state | `web/app.ts` outbox, epoch, playback queue, picker state | Browser/reconnect lifetime; browser does not own server route |
| Deployment | Homelab `damocles` role, not this repository | Owns systemd, env, prompts, secrets, SSH, registry, persona, and cutover |

## Implicit lifecycle

Current route states are effectively `operator`, `project`, `project-to-project`, and transitional setup, with edges for transfer, direct connect, return, failed leg, model redial, forced hangup, idle timeout, and shutdown. They are distributed across:

- PBX mutation and process ownership: `src/pbx.rs:369-588,590-711,1187-1380,1477-1532`.
- API cancellation, generations, task registration, and delivery: `src/api.rs:318-363,532-646,675-809,914-1009`.
- Browser-visible status callbacks and snapshots.

There is no canonical transition record, ordered lifecycle trace, or terminal outcome object. `Reply`, `Turn`, status JSON, and ephemeral `Event` values each describe only slices of a transition.

## Concurrency and rescue

- PBX turns hold `AppState.switchboard` while awaiting `PiSession::prompt`; steering uses the shared session lock instead of the PBX lock.
- Page rescue takes `operation_transition`, increments `turn_generation`, clears pending audio, emits `epoch`, aborts registered tasks, and closes the active session (`src/api.rs:613-632`).
- Capture epochs are stamped in the browser at recording start (`web/app.ts:1048-1077`), checked before transcript persistence, before steering, before queued dispatch, and before delivery.
- Process groups, `kill_on_drop`, `ProcessTreeGuard`, bounded output, and stderr tails are implemented in `src/pi_client.rs:516-700`.
- Rust `handle_agent` has no post-`prompt` same-session check (`src/pbx.rs:491-588`); the legacy equivalent does (`legacy/backend/pbx.py:499-505`) and has a regression test (`legacy/tests/test_pbx.py:770-797`).
- Transfer and redial write route/project/model/session fields before awaited `start_agent` (`src/pbx.rs:636-663,1248-1264`). Rescue during setup can abort before an agent is adopted, leaving project-looking PBX state with no agent and no rollback.
- `active_session` may still point at the operator during that setup window, so rescue can close the operator while the partially-mutated project route remains.

## Protocol and adapters

- Pi tools `transfer_to_project`, `return_to_operator`, `set_model`, and `speak` are detected from `tool_execution_start` (`src/pi_client.rs:367-454`). Routing tools are acknowledgements; PBX performs the mutation.
- `speak` and `diagram` extensions POST to `/speak` and `/diagram` during a turn (`extensions/agent-switchboard.ts:74-244`). Operator tools read the same registry and only acknowledge transfer (`extensions/operator-switchboard.ts:26-120`).
- Missing extensions use `[[SWITCHBOARD:RETURN]]`, parsed by `PiSession`.
- Browser wire events include `epoch`, `status`, `history`, `activity`, `thinking`, `queued`, `transcript`, `reply`, `spoken`, `diagram`, `error`, `audio`, `accepted`, and `pong`. `web/browser.d.ts:1-39` intentionally permits arbitrary fields.
- `static/index.html:731-733` loads committed `static/diagram.js` and `static/app.js`; `npm test` tests protocol, extracted app behavior, extensions, and diagram wave ordering, not a real WebSocket/browser session.

## Compatibility and deployment constraints

- Python remains the compatibility baseline: `legacy/backend/main.py` owns the FastAPI workers and WebSocket; `legacy/backend/pbx.py` owns serialized routing; `legacy/backend/piclient.py` owns the analogous JSONL adapter.
- Legacy has 143 tests versus 46 Rust tests. Rust coverage explicitly lacks direct hangup, idle-drop, WebSocket handler, many `PiSession::collect` branches, and exact transition traces (`docs/observability-and-coverage-handoff.md:89-138`).
- Legacy uses faster-whisper and Whisper-specific settings (`legacy/backend/main.py:96-110`); Rust uses transitional `SWITCHBOARD_STT_COMMAND` (`src/audio.rs:1-12`). Actual model quality and hardware behavior remain unvalidated.
- The documented env contract is in `docs/rust-typescript-migration-handoff.md:115-150`. `SWITCHBOARD_LOG` and `SWITCHBOARD_LOG_FORMAT` are read by Rust but omitted from that contract (`docs/observability-and-coverage-handoff.md:39-52`).
- `SWITCHBOARD_STATE_DIR` and `Config.session` are read but do not establish persistence in the Rust service. Restart intentionally drops calls and in-memory history (`README.md:250-253`).
- Plain extensions are authoritative here, but homelab templates remain deployment authority until a pinned-tag cutover (`AGENTS.md`, `docs/extraction-plan.md`). No deployment change is implied by editing this tree.

## Findings and smallest explicit seams

1. **High:** Lifecycle authority is split between PBX route/process fields, API generation/task state, live-leg mirrors, status snapshots, and browser state. No ordered trace contract exists.
2. **High:** Transfer/redial cancellation can commit partial route state before process adoption.
3. **High:** Rust unavailable model catalogs reject provider-qualified specs at `src/models.rs:216-230`; legacy explicitly passes those through (`legacy/backend/models.py:198-214`), and the migration contract requires that behavior.
4. **High:** Stale-result safety depends on API task abortion rather than a PBX session-identity check after `prompt`.
5. **Medium:** `speak` is marked spoken at signal start, so a failed `/speak` suppresses fallback synthesis (`docs/observability-and-coverage-handoff.md:61-74`).
6. **Medium:** No durable lifecycle trace or restart replay exists; transcript/history is not a substitute for operation history.
7. **Smallest seams:** make session adoption/rollback one explicit PBX boundary; carry generation plus leg identity through operation results; make `PiSession` return terminal signal outcomes rather than signal-start observations; introduce typed lifecycle events separately from transcript/status JSON; add exact trace tests around the existing fake-runtime seam rather than a new process abstraction.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only inspection mapped runtime entry points, ownership, state, concurrency, protocol, extensions, legacy baseline, deployment contracts, tests, and concrete severity-rated findings with paths and line ranges."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read-only repository inspection completed; no files changed and no test/build commands run."
  ],
  "residualRisks": [
    "Rust deployment cutover and live hardware/STT/SSH validation remain outside this repository.",
    "Restart durability and canonical FSM vocabulary remain product decisions.",
    "Rust rescue, idle, WebSocket, and exact lifecycle trace coverage is incomplete."
  ],
  "noStagedFiles": true,
  "diffSummary": "No changes; architecture map only.",
  "reviewFindings": [
    "high: src/pbx.rs:636-663,1248-1264 - transfer/redial mutate route state before awaited agent adoption, allowing rescue cancellation to leave partial project state.",
    "high: src/models.rs:216-230 vs legacy/backend/models.py:198-214 - unavailable catalog behavior diverges from the documented provider-qualified passthrough contract.",
    "high: src/pbx.rs:491-588 vs legacy/backend/pbx.py:499-505 - Rust lacks the legacy same-session stale-result check.",
    "high: src/api.rs:30-54 and src/pbx.rs:166-240 - lifecycle ownership is split without canonical ordered transition traces.",
    "medium: src/pi_client.rs:367-454 and src/pbx.rs:1459 - failed speak calls still suppress fallback synthesis."
  ],
  "manualNotes": "The map is grounded in representative Rust, Python, browser, extension, and test sources. No architecture or behavior changes were made."
}
```

[38;2;136;136;136m✻ Turn took 6m 12s (Total time 6m 12s · 1 turn)[0m