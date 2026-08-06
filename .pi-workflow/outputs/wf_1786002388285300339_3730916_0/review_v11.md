1. **High: SSH host validation is still unspecified.** Plan line 39 merely claims “validated SSH target data”; it gives no validator, rejection rules, or tests. Current raw hosts reach `list_models_argv`, `remote_argv`, `run_prepare`, and `upload_extension_with` (`src/pi_client.rs:753-845`, `src/pbx.rs:837-845,985-994`). Centralize validation and cover option-like/control-character hosts across every caller.

2. **High: the shared speech deadline does not explicitly cover all TTS paths.** The plan specifies `SpeechRequest`, `/speak`, and extension cancellation, but regular turn replies use separate `synthesize_reply_if_current` logic (`src/api.rs`) while `Speaker`/HTTP transport retain their own 30-second timeout (`src/audio.rs`). Require one absolute deadline and cancellation path for mid-turn speech, `/speak`, and settled-reply synthesis, including positive/bounded env parsing.

3. **High: stale clips can remain permanently in the browser outbox.** `process_clips` currently silently drops stale generations, while `web/app.ts` removes outbox entries only on transcript/history/error acknowledgements. Plan line 96 mentions ID-bearing errors but does not require emitting one on the stale-drop path or filtering stale clips before retry. Define that exact server error/removal flow and test reconnect retry after rescue.

4. **Medium: snapshot framing contradicts preserved wire shapes.** Plan line 104 says the writer sends `epoch,status,history,diagram` exactly, but `send_snapshot` omits `diagram` when none exists (`src/api.rs:1092-1110`). State that diagram is conditional, then test both absent/present snapshots without adding a placeholder frame.

5. **Medium: documentation requirements omit an existing contract change.** The migration handoff currently says to keep speak suppression, while the plan changes suppression to require a successful completed tool call. It also does not explicitly document `SWITCHBOARD_SESSION_TOKEN` as a per-process token distinct from the persistent session ID. Require those documentation corrections while retaining the no-legacy/no-homelab boundary.

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 47s (Total time 3m 46s · 1 turn)[0m