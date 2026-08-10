# Switchboard Rust + TypeScript migration handoff

**Status:** in-repository browser/extensions/Rust implementation and automated hardening complete; tagged deployment cutover and live hardware validation remain
**Target:** TypeScript browser/extensions, Rust service backend
**Primary constraint:** preserve call behavior while changing runtimes

## Decision

Migrate the application to:

- **TypeScript** for the browser client and pi extensions.
- **Rust** for the long-running switchboard service: HTTP/WebSocket API,
  routing state, pi process supervision, SSH project sessions, model
  resolution, history, and ElevenLabs HTTP calls.
- **No framework migration in the browser.** Keep the existing page and DOM
  model; compile TypeScript to the static JavaScript the page loads.

The final Rust service should not depend on the Python FastAPI application.
Speech-to-text is the one deliberate implementation choice still open: use a
Rust `whisper.cpp` binding if it meets the current CPU/model behavior; otherwise
run a narrowly scoped STT sidecar during the transition. Do not block the
routing migration on rewriting inference.

This is a behavior-preserving migration, not a redesign. Do not add accounts,
multiple calls, a job queue, a frontend framework, MCP, or a new project
registry.

## Current system

The call path is:

```text
browser WebSocket
  -> Python FastAPI /ws
  -> faster-whisper transcription
  -> Switchboard routing state
  -> local or SSH pi --mode rpc process
  -> reply/activity events
  -> ElevenLabs speech and browser WebSocket
```

Important current modules:

| Current file | Rust/TypeScript destination |
| --- | --- |---|
| `legacy/backend/main.py` | Rust API, WebSocket, workers, lifecycle |
| `legacy/backend/pbx.py` | Rust routing state and leg lifecycle |
| `legacy/backend/piclient.py` | Rust JSONL pi session supervisor |
| `legacy/backend/audio.py` | Rust STT/TTS adapters, or temporary STT sidecar |
| `legacy/backend/registry.py` | Rust registry loader and spoken-name resolver |
| `legacy/backend/models.py` | Rust model catalog and ambiguity checks |
| `legacy/backend/history.py` | Rust history store |
| `static/index.html` | HTML shell plus compiled TypeScript client |
| `extensions/*.ts` | Plain TypeScript pi extensions; persona arrives as `SWITCHBOARD_PERSONA` |
| `legacy/tests/` | Python compatibility tests |
| `tests/` | browser/extension tests |
| `web/` | TypeScript browser protocol, client, and diagram sources |
| `src/` | Rust service modules and tests |
| `static/*.js` | committed deterministic browser build output |

The deployment half remains in the homelab repository. Its systemd unit,
registry, SSH configuration, prompts, persona, environment file, and secrets
are not owned by this repository.

## Contracts that must not change

Write black-box compatibility tests before replacing a component.

### Browser API

- `GET /healthz`
- `GET /status`
- `POST /hangup`
- `POST /connect`
- `POST /thinking`
- `POST /leg-state`
- `POST /speak`
- `POST /diagram`
- WebSocket `/ws`

The WebSocket carries the existing JSON control messages and binary audio
frames. Preserve route/activity/audio message shapes, ordering, reconnect
behavior, and the fact that `/speak` and `/diagram` reach the browser during a
still-running agent turn.

### pi RPC

Preserve newline-delimited JSON commands and events. The supervisor must keep
handling:

- `prompt` and `steer` commands
- `message_update`, `text_end`, and `message_end`
- `tool_execution_start` and `tool_execution_end`
- `agent_settled`
- `extension_error`
- process stderr tails, event timeouts, oversized lines, EOF, and exit status

The following signals are routing events, not ordinary agent output:

- `transfer_to_project`
- `return_to_operator`
- `set_model`
- `speak`

Keep the `[[SWITCHBOARD:RETURN]]` fallback for runtimes that cannot load the
extension. Suppress normal synthesis only after a matching successful
`tool_execution_end` for `speak`; tool start, HTTP failure, stale callback,
`delivered:false`, or TTS failure must leave written fallback eligible.

### Runtime and deployment environment

The Rust service must read the existing names unless a coordinated homelab
change explicitly renames them:

```text
SWITCHBOARD_ENV_FILE
SWITCHBOARD_BIND
SWITCHBOARD_STATE_DIR
SWITCHBOARD_CONFIG_DIR
SWITCHBOARD_PROJECTS_FILE
SWITCHBOARD_OPERATOR_PROMPT
SWITCHBOARD_OPERATOR_EXTENSION
SWITCHBOARD_AGENT_EXTENSION
SWITCHBOARD_PI_BINARY
SWITCHBOARD_OPERATOR_MODEL
SWITCHBOARD_AGENT_MODEL
SWITCHBOARD_AGENT_THINKING
SWITCHBOARD_PERSONA
SWITCHBOARD_REMOTE_CACHE_DIR
SWITCHBOARD_MODEL_SWAPS
SWITCHBOARD_SELF_URL
SWITCHBOARD_IDLE_TIMEOUT
SWITCHBOARD_IDLE_POLL
SWITCHBOARD_MAX_SPOKEN_CHARS
SWITCHBOARD_HISTORY_LIMIT
SWITCHBOARD_SESSION
SWITCHBOARD_SPEAK_URL
SWITCHBOARD_STATE_URL
SWITCHBOARD_DIAGRAM_URL
SWITCHBOARD_STT_COMMAND
SWITCHBOARD_STT_STREAM_COMMAND (optional long-lived framed worker)
SWITCHBOARD_SPEECH_DEADLINE_MS
SWITCHBOARD_LOG
SWITCHBOARD_LOG_FORMAT
```

`SWITCHBOARD_SPEECH_DEADLINE_MS` is a positive bounded millisecond deadline
(default `25000`) shared by `/speak`, normal reply synthesis, the TTS transport,
and the project extension's abort timeout. `SWITCHBOARD_LOG` overrides
`RUST_LOG` for service filter directives; `SWITCHBOARD_LOG_FORMAT` is `text`
(default) or `json`. Deployment overrides for these public variables require a
separate homelab PR.

`SWITCHBOARD_STT_COMMAND` is transitional: it receives complete WebM/Opus bytes
on stdin and must write the transcript to stdout. The optional
`SWITCHBOARD_STT_STREAM_COMMAND` is a long-lived framed worker: each frame is a
kind byte, big-endian `u32` payload length, and JSON control or raw audio
payload. It emits bounded JSONL `ready`, `partial`, and `final` records. The
browser selects it only after the hello capability handshake; a failed or full
worker is explicitly abandoned and the retained complete clip uses the legacy
contract. Adding this variable requires a separate homelab template PR. The Rust service reports this adapter
in `/healthz`; it is not a claim that Rust Whisper matches the deployed
faster-whisper model yet.

`SWITCHBOARD_SESSION`, `SWITCHBOARD_SPEAK_URL`,
`SWITCHBOARD_STATE_URL`, and `SWITCHBOARD_DIAGRAM_URL` are passed to project
agents. They are not merely internal implementation details.

Each project process also receives `SWITCHBOARD_SESSION_TOKEN`, a fresh opaque
per-process callback correlation token distinct from the persistent Pi session
ID. The service validates it for thinking, speech, and diagram callbacks to
reject stale redial work. It is a correlation value, not authentication, and a
deployment must not treat it as a secret.

### Registry and model behavior

Keep the current registry fields and semantics:

```json
{
  "projects": [
    {
      "id": "...",
      "description": "...",
      "aliases": ["..."],
      "host": "...",
      "cwd": "...",
      "runtime": "pi",
      "model": "...",
      "stage_extension": true,
      "extra_args": [],
      "prepare": "..."
    }
  ]
}
```

Preserve forgiving spoken alias matching, ambiguous-match refusal, malformed
entry tolerance, per-host `pi --list-models`, provider-qualified model specs,
thinking-level validation, and the rule that an unavailable catalog may accept
only an already provider-qualified model.

## Target Rust shape

Use one Rust service process with Tokio and an HTTP/WebSocket framework already
approved for the deployment environment. Keep modules aligned with the
current concerns rather than inventing new layers:

```text
src/
  main.rs       configuration and startup
  api.rs        HTTP and WebSocket handlers
  audio.rs      STT/TTS adapters
  pbx.rs        route state and transfer lifecycle
  pi_client.rs JSONL process/session handling
  registry.rs   registry loading and spoken resolution
  models.rs     model catalog and thinking resolution
  history.rs    transcript history
```

The service owns cancellation, child-process reaping, turn serialization,
forced hangup, idle return, model redial, and recovery to the operator. Avoid
sharing mutable routing state through globals merely to mirror the Python
implementation.

The TypeScript browser client should have a small protocol layer separate from
DOM rendering. It should not introduce a state-management library. The pi
extensions remain separate from the browser client and keep their existing pi
`ExtensionAPI`/TypeBox interfaces.

## Phased implementation

### Phase 0: freeze behavior

- Run and record the current Python and Node test suites.
- Add fixture-driven tests for WebSocket frames, HTTP payloads, pi event
  streams, timeouts, signal handling, model ambiguity, and forced hangup.
- Record the deployed homelab environment contract and registry shape.
- Establish a tagged baseline before changing deployment.

**Exit:** a failing compatibility test identifies any intentional behavior
change; no behavior is changed accidentally.

### Phase 1: TypeScript browser client

- Extract the inline browser JavaScript from `static/index.html` into TypeScript.
- Keep the HTML shell, endpoints, message shapes, rendering, accessibility,
  tap-to-talk behavior, diagram behavior, and reconnect behavior unchanged.
- Compile to a deterministic static asset and keep the current Python server
  serving it during this phase.
- Retain the existing Node diagram test and add type-checking to CI.

**Exit:** the Python backend serves the TypeScript-built client with no visible
or protocol difference.

### Phase 2: plain TypeScript pi extensions

- Move persona input from Jinja interpolation to `SWITCHBOARD_PERSONA`, as
  already proposed in `docs/extraction-plan.md`.
- Make the extension sources plain TypeScript and keep their authoritative
  deployment copy in homelab until the homelab migration is merged.
- Test `speak`, `diagram`, transfer, return, model change, state reporting, and
  the no-extension sentinel path.

**Exit:** extension staging and agent callbacks work against the unchanged
Python service; no `.ts.j2` copy is treated as authoritative by accident.

### Phase 3: Rust protocol and process adapter

- Implement `PiSession` in Rust behind fixture tests derived from
  `tests/test_piclient.py`.
- Match JSONL framing, line limits, event timeouts, stderr diagnostics,
  cancellation, child reaping, local execution, SSH execution, `cwd`, env,
  session IDs, and extension staging.
- Run the Rust adapter in a test/shadow mode against captured streams before
  routing live calls through it.

**Exit:** the Rust adapter produces the same turns and signals for the same
captured pi streams, including failure streams.

### Phase 4: Rust routing service

- Port registry/model/history value objects first.
- Port operator/project leg lifecycle and transfer logic next.
- Preserve the single operator leg, one active project leg, recovery to the
  operator on every failed transfer, model redial/session preservation, idle
  timeout, and forced hangup without waiting on the active turn.
- Port HTTP/WebSocket handlers only after the state machine has fixture tests.

**Exit:** black-box tests pass against both Python and Rust services for normal
calls, transfers, mid-turn speak/diagram, model swaps, hangs, and failures.

### Phase 5: audio and TTS

- Implement ElevenLabs HTTP behavior and spoken-text clipping in Rust.
- Benchmark a Rust Whisper implementation against the current
  `faster-whisper` model, CPU thread count, startup time, and transcript quality.
- If the binding is not equivalent, keep STT behind a local sidecar adapter and
  document it as transitional rather than silently changing recognition.
- Never download models or call external services from unit tests.

**Exit:** real hardware validation shows acceptable latency, transcript
quality, TTS behavior, and memory use; test doubles cover all network/audio
paths.

### Phase 6: deployment cutover

In homelab, in a separate reviewed change:

- replace the venv/module systemd command with the pinned Rust binary;
- retain the same service user, working directories, env file, ports, state,
  registry path, SSH config, and secret handling;
- pin the binary release by tag/checksum, never a floating branch;
- update extension and prompt paths only after the Rust service can read them;
- verify `--check --diff`, health, a local operator call, a remote project call,
  hangup, model swap, and rollback before removing Python dependencies.

**Exit:** production can roll back to the last Python deployment by one reviewed
homelab change, and a failed project leg still returns the caller to the
operator.

## Verification matrix

Before each phase is considered complete:

- `python3 -m unittest discover -s legacy/tests` remains green until Python is
  removed.
- The existing Node diagram test remains green.
- TypeScript has a clean type-check and deterministic build.
- Rust unit tests cover parsing and state transitions without network/audio.
- Rust integration tests cover fake pi processes, fake SSH commands, and fake
  TTS/STT adapters.
- A live hardware check covers microphone permissions, WebM/Opus ingestion,
  model startup, speech latency, browser playback, and remote SSH execution.
- Failure tests cover dead pi, dead SSH, malformed registry, missing model
  catalog, extension failure, TTS failure, WebSocket disconnect, timeout,
  forced hangup, and process restart.

## Current verification boundary (2026-08-04)

The repository now has a CI workflow for the Python compatibility suite, the
deterministic TypeScript build, browser/extension tests, Rust formatting, Rust
tests, and Clippy. Rust tests use local doubles for pi RPC, SSH command
construction/execution, ElevenLabs transport, and the STT sidecar. They also
exercise forced rescue during a wedged PBX operation, superseded-result
suppression, graceful shutdown notification, model/catalog degradation,
bounded process output, remote extension staging, and transfer/return lifecycle
behavior. No test calls ElevenLabs, downloads a speech model, or reaches a
project host.

Speech captured before a page transfer is epoch-tagged so it cannot act on the
leg that replaced it, across the queued-turn path and the steering path alike.
The epoch is stamped when recording starts: the server announces it on every
change and in the WebSocket snapshot, and the browser puts it on the clip header.
Neither transcription nor upload is early enough to be safe, since a transfer can
land inside either. A client that sends no epoch falls back to arrival time and
behaves as it did before.

The browser half of that has no automated coverage — `web/app.ts` reads the DOM
at module load and there is no harness for it, so the wire format lives in
`web/protocol.ts` where `tests/test_protocol.mjs` can reach it. That the recorder
stamps the right value is currently established by reading the code, and belongs
on the live hardware checklist.

The following acceptance gates deliberately remain outside this repository:

- establish and publish the release tag/checksum used by deployment (this
  repository currently has no tag that can serve as the pinned cutover);
- merge the separate homelab change that pins that release, moves the rendered
  persona contract, updates the unit, and retains a one-change Python rollback;
- benchmark the configured STT sidecar or Rust Whisper candidate against the
  deployed faster-whisper model on damocles;
- run the live microphone/WebM, browser playback, local operator, remote SSH
  project, model-swap, hangup, restart, and rollback checks on actual hardware.

Those are not optional completion claims: automated doubles establish software
behavior, but cannot establish credentials, codecs, model quality, device
permissions, network reachability, or production rollback.

## Handoff rules

- Do not edit homelab deployment templates from this repository and assume the
  change is deployed.
- Do not rename a `SWITCHBOARD_*` variable without a coordinated homelab PR.
- Do not replace failure recovery with a generic HTTP 500; the caller must be
  returned to the operator or receive an audible error.
- Do not make the operator or project agent responsible for routing state.
- Do not delete Python audio code until the Rust path has been validated on the
  actual host and model files used by deployment.
- Keep commits phase-sized and reversible. The final cutover should be a
  separate commit from deleting the Python implementation.
