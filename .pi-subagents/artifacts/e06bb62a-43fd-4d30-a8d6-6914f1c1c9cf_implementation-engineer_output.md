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