# Observability and test-coverage handoff

**Status (2026-08-04):** logging pass largely complete and green on every CI
gate; test-coverage pass not started. This document records what was found, what
was changed, and what is left, in enough detail to resume without redoing the
audit.

The work was scoped by four parallel audits: Python→Rust logging parity,
Python→Rust test parity, Rust service debuggability, and browser/extension
observability. Their findings are summarized here; the audits themselves are not
preserved anywhere else.

## The finding that mattered most

`src/main.rs` called `tracing_subscriber::fmt::init()`. That builds its filter
with `EnvFilter::from_default_env()`, whose default directive when `RUST_LOG` is
unset is `error`. The tree contained two `error!` calls in total.

Verified empirically before the change: running the binary for 25 seconds with
no `RUST_LOG` produced **zero output** — not even its own
`info!("switchboard listening")`. Unless the homelab systemd unit sets
`RUST_LOG`, the deployed service ran entire calls, dropped legs, failed to stage
extensions and refused model swaps in complete silence.

This is now `init_tracing` in `src/main.rs`, with `DEFAULT_LOG_FILTER =
"switchboard=info,warn"`. The same invocation now reports its configuration, the
registry load, and the bind address.

## What changed

Log sites went from 18 to 105.

| file | before | after | notes |
|---|---|---|---|
| `src/api.rs` | 0 | 31 | whole call state machine was silent |
| `src/pbx.rs` | 11 | 35 | routing/transfer/redial/hangup/idle |
| `src/pi_client.rs` | 2 | 17 | RPC protocol parser, process lifecycle |
| `src/registry.rs` | 0 | 10 | every load failure was a silent discard |
| `src/main.rs` | 5 | 9 | subscriber, config line, setting rejects |
| `src/models.rs` | 0 | 3 | catalog fetch failures |
| `src/audio.rs` | 0 | 0 | **not started — see checklist** |
| `src/history.rs` | 0 | 0 | Python has none either; correctly consistent |

Two new environment variables, both read in `src/main.rs`:

- `SWITCHBOARD_LOG` — filter directives, takes precedence over `RUST_LOG`.
  Preferred because the deployment env file is the only config surface this repo
  shares with homelab, and `RUST_LOG` there would leak into every process the
  unit starts.
- `SWITCHBOARD_LOG_FORMAT` — `text` (default) or `json`.

Per `AGENTS.md`, every `SWITCHBOARD_*` name is public interface. **These two are
not yet added to the env-variable list in
`docs/rust-typescript-migration-handoff.md`, and the homelab PR that documents
them has not been written.** See the checklist.

`Cargo.toml` gained the `json` feature on `tracing-subscriber`; `Cargo.lock` is
updated accordingly.

### The correlation key

There is no per-call span. The clip id already spans the whole path — the
browser mints it, the transcript carries it, every error frame quotes it — so it
is now logged at each stage instead: accepted → transcribing → transcribed →
dispatched → settled. `journalctl -u switchboard | grep <clip-id>` reconstructs
one utterance end to end. A real per-connection span is still worth doing but was
not needed to make the path traceable.

## Behavioral defect and deliberate follow-up

The Mermaid feedback gap remains pre-existing and shared with the Python
baseline, so fixing it is a redesign, which
`docs/rust-typescript-migration-handoff.md` forbids without a separate decision.
The speech fallback defect was corrected in the Rust path and is covered by the
signal-correlation tests.

1. **Failed `speak` fallback is now explicit and correlated.**
   `src/pi_client.rs` records the tool call id at `tool_execution_start`, but
   `Turn::agent_spoke()` becomes true only after a matching successful
   `tool_execution_end`. HTTP failure, stale/candidate callback rejection,
   `delivered:false`, and TTS failure therefore leave the written reply eligible
   for normal switchboard synthesis. This is intentionally a Rust-side behavior
   correction; the legacy tree remains the compatibility baseline and is not
   edited here. The extension marks `delivered:false` as `isError`, while the
   server keeps the written transcript/event so the caller has a visible trail.

2. **A malformed Mermaid diagram is unreportable to the agent.** `/diagram` in
   `src/api.rs` does no validation and returns `delivered: true` whenever a
   browser is attached, so the tool says "On screen." while the page shows a
   parse error. `docs/diagram-tool.md` treats the one-way design as final; a fix
   needs a round trip.

## Checklist

### Logging — remaining

- [ ] `src/audio.rs` still has zero log sites. Add: STT sidecar command being
      run and its duration; sidecar non-zero exit with its stderr; the
      ElevenLabs request (voice/model id, character count), its HTTP status and
      latency; response-size-limit rejections. The error *values* are already
      well-formed here — they are returned to callers who log them — so this is
      the lowest-severity remaining gap, which is why it was left.
- [ ] `src/api.rs`: the `/hangup`, `/connect`, `/thinking`, `/leg-state`,
      `/speak` and `/diagram` handlers still have no entry/outcome lines. The
      workers and websocket path are done; the HTTP endpoints are not. Callback
      failures are bounded and returned to the extension, but endpoint-level
      arrival/outcome logging remains follow-up work.
- [ ] Consider a per-connection `info_span!` carrying a connection id so
      concurrent tabs can be told apart. The clip id covers the common case.

### Tests — not started

Baseline: **46 Rust tests vs 143 Python.** The audit mapped ~91 behaviors
covered in Python and not in Rust. Ranked by risk:

- [ ] **A turn in flight cannot undo a rescue.** `src/pbx.rs::handle_agent` has
      no same-session re-check after `await session.prompt(...)`, where
      `legacy/backend/pbx.py:499` does, and `test_pbx.py:770` pins it. Rust
      relies entirely on `api.rs` aborting the task from outside, and no test
      proves that actually stops a stale reply swinging the route back. Confirm
      whether this is a real gap or an intentional relocation of the check.
- [ ] `Switchboard::force_hangup` has zero direct tests (Python has three).
- [ ] Idle-drop is untested on both sides of the boundary:
      `PiSession`'s silence deadline and `Switchboard::return_if_idle`. Python
      documents a shipped bug here ("Nothing recovered") caused by a whole-turn
      rather than silence deadline; Rust has no guard against that regression.
- [ ] `redial` failure paths: ambiguous model must not tear down the live leg;
      a leg that will not come back up must land on the operator.
- [ ] `transfer` failure paths: `start_agent` error, intro prompt never answered.
- [ ] `PiSession::collect` branches: oversized event, EOF before `agent_settled`,
      non-JSON lines skipped, `message_end` error-vs-healthy. Only needs small
      variations on the existing fake-`sh`-script pattern.
- [ ] `remote_argv` must start `set -e;` and export before `exec` — the bad-cwd
      abort guarantee `test_piclient.py:468` documents.
- [ ] The `websocket()` handler has no test at all: ping/pong, invalid JSON,
      unknown command, audio without a header, the `Lagged` recovery branch, and
      the snapshot ordering (epoch → status → history → diagram).
- [ ] `/hangup` is never called by any test.
- [ ] Cheap and mechanical: ~11 `models.rs` cases, ~7 `registry.rs`, ~6
      `audio.rs` (including `Speaker::configured()` returning false, which gates
      the production `/speak` 502), 2 `history.rs`.
- [ ] **New code from this pass is itself untested** — `Registry::parse_entry`'s
      unknown-key and blank-id branches, `init_tracing`'s malformed-filter
      fallback, and `number`/`usize_value`'s reject-and-warn paths.

**Structural note:** `pbx.rs` has 8 tests to Python's 59 because `Switchboard`
calls `PiSession::start` directly with no injection seam, so the only way to
drive it is a real fake-`pi` shell script. The existing `fake_runtime()` helper
in the `pbx.rs` test module already does this and is the recommended path —
prefer it over introducing a trait seam, which would be a design change.

### Browser and extensions — not started

- [ ] `web/*.ts` contains **zero** `console.*` calls. `onclose`/`onerror` are
      zero-argument arrows, discarding `CloseEvent.code`/`.reason` entirely.
      Undecodable frames and unknown message types are dropped with no trace.
- [ ] The Mermaid CDN import is unguarded; if it fails, `window.renderDiagram`
      is never defined and diagrams silently no-op forever.
- [ ] `mermaid.parse(src, { suppressErrors: true })` discards the parser's real
      error, so the page can only ever say "That diagram did not parse."
- [ ] `postJson` throws `HTTP <status>` and discards the response body, so
      server-side `detail` strings never reach the page.
- [ ] Extensions swallow `reportThinking()` and registry-read failures with
      empty catches. Their stderr *is* captured by `src/pi_client.rs` and
      surfaced in `PiSessionError`, so a `console.error` there reaches an
      operator for free.
- [ ] `web/app.ts` (1008 lines) exports nothing and is entirely untested,
      including `renderMarkdown`, which has a documented prior bug and stands
      between agent-controlled text and DOM rendering.

## Gate status at handoff

All five CI gates pass:

```
cargo fmt --all -- --check          ok
cargo test --locked                 46 passed
cargo clippy --locked --all-targets -- -D warnings   clean
python3 -m unittest discover -s legacy/tests         143 passed
npm test && git diff --exit-code -- static           ok, static in sync
```

Nothing is committed — the whole change is in the working tree
(8 files, +611/−89).
