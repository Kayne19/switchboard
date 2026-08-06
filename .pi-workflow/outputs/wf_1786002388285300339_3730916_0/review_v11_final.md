No concrete blockers found.

1. A shared `ValidatedSshTarget` is explicitly required for all four SSH paths, with common rejection rules and constructor.
2. `SWITCHBOARD_SPEECH_DEADLINE_MS` is positive and bounded; one absolute cancellation path covers `/speak`, `process_speech`, reply synthesis, `Speaker`, and `HttpTtsTransport`.
3. Stale clips emit ID-bearing `stale_epoch` errors; browser outbox removal and reconnect filtering are explicit.
4. Snapshots send `diagram` only when present, preserving existing frames and ordering.
5. Documentation corrections cover successful `tool_execution_end` semantics and distinguish fresh per-process tokens from persistent session IDs.

No earlier invariant is damaged.

VERDICT: APPROVE

[38;2;136;136;136m✻ Turn took 2m 28s (Total time 2m 27s · 1 turn)[0m