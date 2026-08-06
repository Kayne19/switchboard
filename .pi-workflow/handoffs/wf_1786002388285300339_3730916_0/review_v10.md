# Handoff Output: review_v10
Status: success
Verdict: REVISE
Timestamp: 1786008465

## Content
# Adversarial review

1. **High: stale browser work is not carried forward.**  
   `docs/concurrency-and-test-hazards.md:19-48` requires recording-start epoch stamping, stale transcript suppression before persistence, and rechecks for both steering and queued turns. Plan §5 only mentions Coordinator generation; §8 omits clip headers, stale transcript acknowledgements, and outbox removal. A pre-rescue clip can still be persisted, retried, or acted on by the replacement leg.

2. **High: `session_start` thinking is rejected and then lost.**  
   `extensions/agent-switchboard.ts:41-61` reports thinking before any prompt operation. Plan §3 rejects callbacks with no active operation, while §4 says candidate thinking is private, but defines no startup/adoption transfer. The adopted leg can remain permanently `thinking_confirmed:false`.

3. **High: operation serialization incorrectly claims `PiSession` protects `steer`.**  
   `src/pi_client.rs:84,210-259` locks prompts, but `steer` does not acquire that turn lock. Current mid-turn steering is exercised through `src/api.rs:465-490`. Plan §3 both requires `begin_operation` for steer and rejects concurrent operations, without defining how steer attaches to the existing prompt operation. Implementation can either break caller interruption or admit uncorrelated callbacks.

4. **High: SSH host validation remains absent across callers.**  
   `src/pi_client.rs` has separate `list_models_argv` and `remote_argv`; `src/pbx.rs` separately builds SSH commands for `run_prepare` and `upload_extension_with`. Plan v10 does not centralize validation or reject option-like/control-character hosts, leaving an SSH option/injection path.

5. **High: catalog publication ordering is contradictory.**  
   Plan §2 says publish the candidate catalog before adoption, then says failed candidates leave only unpublished state. There is no atomic publication with `adopt_candidate` or defined version/pointer barrier. Status can observe an old lifecycle with a newly published catalog, violating the claimed coherent projection.

6. **High: the “shared” speech deadline is still two literals and lacks a concrete cancellation channel.**  
   `extensions/agent-switchboard.ts` is assigned `25_000`, while Rust is assigned `25 seconds`; no shared source/contract or precise HTTP-disconnect-to-worker cancellation mechanism is defined. `SpeechRequest` fields alone do not prove that an aborted fetch prevents TTS or writer commit.

7. **Medium: diagnostics requirements are missing.**  
   `docs/observability-and-coverage-handoff.md` requires bounded trace correlation, diagnostic sanitization, and explicit logging/coverage. Plan §4 only says “bounded cleanup diagnostics”; it specifies no diagnostic owner, ring/sequence limits, secret exclusion, stderr/error caps, or tests.

8. **Medium: earlier model compatibility is incomplete.**  
   Plan §8 covers catalog matching and passthrough but does not explicitly preserve current thinking suffixes during redial (`src/pbx.rs:1200-1213`) or retain the current model in the picker when absent from a populated catalog (`web/app.ts:604-615`). These were prior review requirements and need named regression tests.

The ExtensionAPI decision and fail-closed SSH same-session policy are correctly preserved. The writer barrier and candidate rollback are directionally implementable, but the omissions above remain implementation-blocking.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Eight concrete findings remain, covering stale work, callback lifecycle, operation locking, SSH validation, catalog atomicity, speech cancellation, diagnostics, and model compatibility."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read-only inspection of plan_v10, review_v2 through review_v9, repository sources, and concurrency/observability documentation",
      "result": "passed",
      "summary": "Verified the remaining gaps against concrete callers and documented invariants."
    }
  ],
  "validationOutput": [
    "ExtensionAPI execute(toolCallId, params) was verified without inventing callback metadata.",
    "Fail-closed SSH same-session redial remains intact.",
    "WebSocket barrier and candidate cleanup claims require the unresolved lifecycle and cancellation corrections above."
  ],
  "residualRisks": [
    "Pre-rescue speech may reach durable history or a replacement leg.",
    "Adopted legs may lose effective thinking state.",
    "Concurrent steering and callbacks may be miscorrelated.",
    "Unvalidated SSH hosts may alter SSH option parsing.",
    "Catalog, TTS, and diagnostics state may not be atomically or observably correct."
  ],
  "noStagedFiles": true,
  "diffSummary": "Planning-only adversarial review; no repository files changed.",
  "reviewFindings": [
    "high: docs/concurrency-and-test-hazards.md:19-48 and plan §5/§8 - browser turn-epoch and stale-work requirements omitted",
    "high: extensions/agent-switchboard.ts:41-61 and plan §3/§4 - session_start thinking callback is rejected and lost",
    "high: src/pi_client.rs:84,210-259 and src/api.rs:465-490 - steer operation serialization is not defined",
    "high: src/pi_client.rs list_models_argv/remote_argv and src/pbx.rs SSH callers - host validation is not centralized",
    "high: plan §2 - catalog publication before adoption contradicts failed-candidate nonpublication",
    "high: extensions/agent-switchboard.ts and src/audio.rs - speech deadline is not a genuinely shared cancellable contract",
    "medium: docs/observability-and-coverage-handoff.md - diagnostics ownership, bounds, and tests are absent",
    "medium: src/pbx.rs:1200-1213 and web/app.ts:604-615 - prior model compatibility requirements are not explicit"
  ],
  "manualNotes": "Revise before implementation. Preserve the explicit leg-scoped callback alternative and fail-closed remote same-session policy."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 5m 19s (Total time 5m 18s · 1 turn)[0m