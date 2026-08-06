# Handoff Output: review_v8
Status: success
Verdict: REVISE
Timestamp: 1786007199

## Content
# Adversarial review

1. **Critical: §5’s remote lock design is not implementable as written.**  
   `src/pi_client.rs:753-850` constructs a remote shell command, but `openat`/FD 9 would operate on the local host, not the SSH target. `O_CLOEXEC` also contradicts “hold through exec.” The lock root path, collision-resistant key derivation, and remote helper/protocol are unspecified. Same-session redial remains unsafe. Fail closed or define a real remote lock helper and invariant.

2. **High: operation identity has no registration or ordering mechanism.**  
   `src/pi_client.rs:215-244,410-445` parses tool events only after the extension callback may already run. §3 rejects unknown operations, yet never specifies how `toolCallId` is registered before `/speak` or `/diagram`. The Pi extension context API carrying generation/operation fields is also asserted, not identified or tested.

3. **High: the lock model omits existing mutexes and cannot prove nonblocking status.**  
   `src/api.rs:32-54,176-222` has transcript, active-operation, session, diagram, and channel locks beyond C/D/P. Catalog state remains in `Switchboard` behind P, while §8 requires fresh status without P. Define all lock order and an independently readable catalog/status projection.

4. **High: remote shutdown is still only a claim.**  
   `PiSession::close` (`src/pi_client.rs:197-212`) drops stdin and kills the local SSH child; no remote shutdown command or acknowledgement protocol exists. §4’s “remote shutdown and wait” cannot be implemented or tested against the current RPC contract.

5. **High: WebSocket writer lifecycle and wire compatibility remain incomplete.**  
   Current delivery is broadcast plus per-socket sends (`src/api.rs:1018-1110,1258-1270`). §6 does not specify registration-before-snapshot buffering, writer shutdown, lag recovery, or replacement races. “Combined audio frame” risks breaking `web/app.ts:963-974`, which expects JSON metadata followed by binary audio.

6. **High: speech fallback correlation is underspecified.**  
   `Turn::agent_spoke` currently records `tool_execution_start` (`src/pi_client.rs:54,414-438`). The plan requires successful matching ends but does not define the end-event success field or extension behavior. Current `/speak` delivered-false responses are HTTP 200 and omit `isError` (`extensions/agent-switchboard.ts:202-224`), so written fallback can still be suppressed.

7. **Medium: omitted lifecycle callers and candidate side effects.**  
   `spawn_idle_worker` directly calls `return_if_idle` (`src/api.rs:267-290`), and shutdown directly mutates PBX state (`src/api.rs:259-265`), outside the listed coordinator transactions. Candidate `run_prepare` and extension staging (`src/pbx.rs:633,827,951`) mutate local/remote state before adoption without rollback or serialization.

8. **Medium: scope contradicts documentation requirements.**  
   §7 requires migration-document edits, while the declared scope forbids documentation changes. The existing migration document also explicitly requires preserving newline JSONL and existing WebSocket binary framing.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Plan_v8 still leaves critical remote-lock, identity-registration, shutdown, transport, fallback, lock-order, and omitted-caller gaps."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Findings cite concrete repository paths, current mechanisms, plan sections, failure modes, and required closure."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only repository, plan, and prior-review inspection",
      "result": "passed",
      "summary": "Checked all ownership rows and relevant Rust, extension, browser, and migration-contract call paths."
    }
  ],
  "validationOutput": [
    "Prior review_v7 findings were rechecked and several remain unresolved at implementation level."
  ],
  "residualRisks": [
    "Unsafe same-session remote overlap",
    "Rejected legitimate callbacks due missing operation registration",
    "Status blocking or stale projections",
    "Remote process surviving local SSH teardown",
    "Lost or duplicated speech and broken audio wire framing"
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only final adversarial review; no source changes.",
  "reviewFindings": [
    "critical: src/pi_client.rs:753-850 and plan §5 - remote FD lock strategy is not implementable over SSH",
    "high: src/pi_client.rs:215-244,410-445 and plan §3 - operation registration/context propagation is unspecified",
    "high: src/api.rs:32-54,176-222 and plan §2/§8 - lock model omits mutexes and catalog freshness path",
    "high: src/pi_client.rs:197-212 and plan §4 - remote shutdown protocol is absent",
    "high: src/api.rs:1018-1110 and web/app.ts:963-974 - exact writer lifecycle and wire framing are incomplete",
    "high: src/pi_client.rs:54,414-438 and extensions/agent-switchboard.ts:202-224 - speak fallback success correlation is incomplete",
    "medium: src/api.rs:267-290 and src/pbx.rs:633,827,951 - omitted callers and candidate setup side effects",
    "medium: plan §7 and docs/rust-typescript-migration-handoff.md - scope/documentation conflict"
  ],
  "manualNotes": "Prefer a simpler fail-closed same-session redial policy over an unprovable remote filesystem guarantee."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 5m 9s (Total time 5m 9s · 1 turn)[0m