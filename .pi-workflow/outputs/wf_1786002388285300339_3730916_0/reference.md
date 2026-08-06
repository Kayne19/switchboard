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