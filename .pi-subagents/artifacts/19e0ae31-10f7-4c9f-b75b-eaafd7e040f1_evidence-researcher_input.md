# Task for evidence-researcher

Using the completed `reference` and `switchboard` handoffs, compare the two systems as an architecture audit. Do not edit either repository. Identify where switchboard violates or lacks the reference's useful doctrines: central state ownership, phase/state visibility, event contracts, persistence/runtime separation, task-shaped components, transport adapters, and explicit testable boundaries. Distinguish genuine architectural gaps from domain differences that should not be copied. Produce a prioritized gap register with evidence paths, blast radius, migration order, risks, and a proposed target boundary map.

## Context from phase 'reference'
# Handoff Output: reference
Status: success
Verdict: (none)
Timestamp: 1786003012

## Content
# AI-Linux-Assistant architecture map

Read-only inspection followed `AGENTS.md:1`, then `graphify-out/architecture/wiki/index.md:1`; excluded `.git`, caches, `node_modules`, and dependency noise. No commands or files were modified.

## Boundaries and ownership

- **Process boundary:** `run_dev.py:48-53,198-322` launches FastAPI, Vite, optional Redis, and multiple workers. `run_public_api.py:26-176` separates API, workers, Redis, and optional Cloudflare Tunnel. Deployment intent is documented in `Back-end/infra/public-api/README.md:1-83`.
- **API/auth boundary:** `Back-end/app/api.py:658-1008,1267-1373` validates scope, creates/reuses runs, exposes snapshots/events, and streams replay/live data. It does not execute the router FSM. `Back-end/app/auth/auth0.py:37-211` verifies RS256/JWKS/issuer/audience/expiry and maps `(auth_provider, auth_subject)` to local users.
- **Application persistence:** `Back-end/app/persistence/postgres_models.py:158-257` defines chats, messages, `ChatRun`, and monotonic-sequence `ChatRunEvent`. `postgres_app_store.py:20-300` owns users/projects/chats/messages and owner-scoped access.
- **Durable run control:** `postgres_run_store.py:24-72,178-299,419-717,860-1254` owns statuses, idempotency, active-run limits, leases, worker ownership, cancellation, pause/resume, terminalization, and durable event ordering. `chat_run_worker.py:356-421,528-765` owns claim execution, heartbeats, checkpoint flushing, stale-work handling, and one fresh router per run.
- **Canonical turn FSM:** `model_router.py:46-94,167-183,215-346` defines `RouterState`, `TurnContext.state_trace`, transition dispatch, cancellation checkpoints, listeners, and terminal error conversion. Phase handlers are `model_router.py:1462-1770`: memory, history, classify, RAG decision/rewrite/retrieve, response, history update, memory extraction/resolution/commit, auto-name, done/error.
- **Nested task protocols:** `ResponseAgent` has a task FSM (`response_agent.py:11-185`); `MagiSystem` has an explicit role/discussion FSM (`magi/system.py:7-117,426-478,569-876,975-1128`). The router prefixes nested Magi trace markers in `model_router.py:577-625`.
- **Agents/providers:** task-shaped agents own extraction, classification, contextualization, response, and resolution (`AGENT_ROLES.md:5-30`). Provider callers own request formatting/parsing/retry/structured output/cancellation transport (`PROVIDERS.md:5-30`), though actual OpenAI convenience paths still loop tool calls (`openAI_caller.py:531-665,670-829`).
- **Retrieval:** router chooses whether/what to retrieve; `EvidencePool` tracks per-turn evidence, fingerprints, coverage, usefulness, and exhaustion (`evidence_pool.py:287-775`). Search owns embedding, scoped hybrid search, reranking, bundling, formatting, and retrieval events (`search_pipeline.py:373-689`; `RETRIEVAL.md:5-34,167-320`). Ingestion owns indexing (`ingestion/indexer.py:1-300`).
- **Memory:** router owns visible `LOAD_MEMORY -> EXTRACT_MEMORY -> RESOLVE_MEMORY -> COMMIT_MEMORY`; extractor normalizes model candidates; resolver owns commit/conflict policy; store persists/query-only (`MEMORY.md:23-174`). `postgres_memory_store.py:29-207,408-844` detects stale snapshots and isolates candidates by `(project_id, chat_session_id)`.
- **Ingestion:** separate operator subsystem, not chat runtime (`INGESTION.md:7-34`). `pipeline.py:487-760` drives the explicit document FSM and trace; `batch_runner.py:1-330` advances parked durable docs; `doc_state.py:29-110` atomically-ish replaces `state.json`; `trace.py:1-104` persists run/document traces and artifacts.
- **Frontend:** React renders backend truth, owns Auth0 UX, optimistic per-chat state, labels, reconnect UX, council rendering, and debug UI (`FRONTEND.md:5-203,221-325`). `api.ts:44-188` parses/dispatches SSE; `runStreamSession.ts:1-85` reconnects with `after_seq`; `useStreamingRun.ts:500-775` handles checkpoint seeding, stale UI rescue, pause/resume, and terminal reconciliation.

## Contracts and data flow

- Durable lifecycle is `queued -> running -> cancel_requested/pause_requested -> paused/completed/failed/cancelled`; event rows contain `run_id, seq, type, code, payload_json, created_at` (`RUNS.md:40-116`).
- `serialize_run_event()` is the sole wire formatter for Postgres replay and Redis fanout (`streaming/event_serializer.py:1-31`; `redis_events.py:1-75`). Redis is live-only; Postgres `chat_run_events` is replay authority (`STREAMING.md:341-405`).
- State events carry machine codes; generic events carry phase-owned payloads; terminal events carry done/error/cancelled/paused payloads. Partial text uses live `text_delta` plus durable absolute `text_checkpoint`; Magi uses analogous role checkpoints (`STREAMING.md:34-109,306-395`).
- Worker terminal `done.debug` carries `state_trace`, `tool_events`, retrieval metadata, and canonical `normalized_inputs`; large prompt-facing blobs are centralized there (`chat_run_worker.py:435-480`; `normalized_inputs.py:1-165`).
- Provider transport normalizes `ProviderToolCall` and `ProviderStepResult` (`providers/step_protocol.py:1-18`). Magi role/council entries carry role, phase, round, text, and intervention metadata (`magi/system.py:879-946`).

## Dependency direction

`run_* / scripts -> app entrypoints -> API or worker -> stores/auth/streaming + router -> task agents -> provider transport`; runtime retrieval is `router -> search pipeline -> LanceDB/provider adapters`; ingestion is `CLI -> ingestion pipeline -> stages/indexer -> retrieval storage`; frontend depends only on FastAPI, never router or persistence directly.

## Verification strategy

- Exact happy-path router trace: `tests/test_router_runtime.py:271-288`; branch omissions and error trace assertions: `:434-483,1194-1352`.
- Magi event/state ordering, bounded discussion, gates, early stop, pause/resume intervention: `tests/test_magi_system.py:408-705,708-949`.
- Idempotency, active-run policy, monotonic terminal events, stale-worker rejection: `tests/test_run_store.py:130-450`.
- Serializer and Redis wire equivalence: `tests/test_run_streaming.py:60-206`.
- Memory candidate isolation and stale snapshot refresh: `tests/test_postgres_memory_store.py:187-232,252-314`.
- Retrieval scope narrowing/widening and explicit document pins: `tests/test_retrieval_scope_runtime.py:164-212`; ingestion durable FSM and failures: `tests/test_batch_runner.py:191-382,448-499`; auth ownership: `tests/test_api_auth.py:135-179`.

## Transfer to switchboard

Transfer: one explicit lifecycle owner, phase-owned events, monotonic sequence numbers, task-shaped adapters, cooperative cancellation checkpoints, canonical compact input snapshots, backend-enforced scope, stale-generation/lease rejection where concurrency exists, and exact trace assertions for success/failure/race paths.

Do not transfer wholesale: Postgres chat-run queues, Redis fanout, Auth0/M2M, per-user concurrency caps, React optimistic machinery, Magi council protocol, or ingestion’s document FSM. For switchboard’s one-caller scope, those add durable infrastructure without product semantics. Also do not copy the provider doctrine blindly: the actual OpenAI caller still owns repeated tool loops, so enforce adapter boundaries in code, not documentation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only architecture map covers process, API/auth, durable runs, router and nested FSMs, persistence, retrieval, memory, ingestion, providers, frontend, contracts, dependency direction, tests, and transfer guidance with concrete paths and line ranges."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection only",
      "result": "not-run",
      "summary": "No tests or write-oriented commands were run."
    }
  ],
  "validationOutput": [
    "Read AGENTS.md and graphify architecture index first.",
    "Read maintained architecture documents and representative runtime/test files.",
    "Excluded generated caches, dependency noise, .git, and node_modules."
  ],
  "residualRisks": [
    "Reference documentation claims provider transport-only boundaries that OpenAI convenience implementations do not fully enforce.",
    "Switchboard durability and concurrency semantics remain product decisions."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed.",
  "reviewFindings": [
    "high: Back-end/app/providers/PROVIDERS.md:5-30 versus Back-end/app/providers/openAI_caller.py:531-829 - documented adapter boundary is looser than the actual provider tool-loop implementation.",
    "medium: Back-end/app/orchestration/model_router.py:46-346 and Back-end/app/agents/magi/system.py:7-117 - multiple coordinated FSMs are explicit and testable, but should not be mistaken for a single universal lifecycle authority.",
    "medium: Back-end/app/persistence/postgres_run_store.py:24-72,419-717 - durable run/lease machinery is valuable only when restart survival, replay, or multi-worker concurrency is required."
  ],
  "manualNotes": "Reference artifact is compressed intentionally; no implementation recommendation was made for switchboard."
}
```

[38;2;136;136;136m✻ Turn took 6m 49s (Total time 6m 48s · 1 turn)[0m

## Context from phase 'switchboard'
# Handoff Output: switchboard
Status: success
Verdict: (none)
Timestamp: 1786002976

## Content
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

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/compare.md
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