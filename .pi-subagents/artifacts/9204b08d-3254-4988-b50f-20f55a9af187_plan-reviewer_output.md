# Adversarial review

1. **High: remote lock identity is not safety-complete.**  
   `src/pi_client.rs::remote_argv` is specified to use “bounded hex encoding,” but the plan does not define collision handling, rejection of oversized inputs, lock-directory location, or secure creation. Truncation can make distinct `(host, session_id)` pairs share a lock and violate the no-overlap guarantee. Require collision-resistant fixed-length derivation or reject unrepresentable identities, plus a test.

2. **High: `/speak` can still duplicate speech on timeout.**  
   `extensions/agent-switchboard.ts:98-103` has a 30-second fetch timeout, while `src/audio.rs` also allows 30-second TTS requests. The plan adds a oneshot but does not define an endpoint deadline, cancellation, or worker-health mechanism. The extension can mark the tool failed and trigger fallback while the server later delivers the original audio. Define one bounded deadline and cancellation/late-result behavior; test it.

3. **Medium: stale socket results can wedge audio ordering.**  
   `src/api.rs::AudioQueue` reserves ordered slots, while `finish_audio` currently returns early for stale generations. The plan adds socket-epoch rejection but does not specify cancellation/finalization of a reserved slot on epoch mismatch. A disconnected browser can leave sequence N pending forever, blocking later audio. Add an explicit reservation-cancel path and reconnect-during-TTS test.

4. **Medium: same-session quiescing leaves an acceptance window.**  
   During redial, the old token appears to remain authoritative until candidate adoption, while the old SSH process is being terminated. `/speak`, `/leg-state`, or `/diagram` callbacks arriving in that interval may mutate state despite the leg being quiesced. Define a `quiescing` rejection phase and test all callback types, not only candidate callbacks.

5. **Medium: status mirror ownership remains ambiguous.**  
   `src/api.rs::status_snapshot`, `current_status`, and `publish_status` are not named in the removal mapping. If `status_snapshot` remains authoritative, lifecycle state is still duplicated in `AppInner`; if it is only a presentation cache, state that explicitly and require coordinator refresh tests.

The prior explicit blockers are otherwise addressed: activity ownership is named for removal, remote locking is introduced, speech success requires acknowledged TTS/tool completion, and trace retention/sanitization tests are listed. These remaining races and timeout semantics prevent approval.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Plan v4 closes the previously listed blockers in principle, but remote lock identity, asynchronous speech timeout/worker failure, stale audio reservation, callback quiescence, and status mirror ownership remain underspecified."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read-only inspection of plan_v4 against src/api.rs, src/pbx.rs, src/pi_client.rs, src/audio.rs, and extensions/agent-switchboard.ts.",
    "Prior review blockers were checked against the revised plan."
  ],
  "residualRisks": [
    "Lock-key collisions or unspecified lock placement could permit same-session overlap.",
    "A 30-second client/server timeout race can produce duplicate speech.",
    "Socket-stale audio may block subsequent ordered audio.",
    "Callbacks may be accepted while an old leg is being quiesced.",
    "status_snapshot may remain a second lifecycle authority."
  ],
  "noStagedFiles": true,
  "diffSummary": "No source changes; read-only plan gate.",
  "reviewFindings": [
    "high: src/pi_client.rs::remote_argv - bounded lock-key derivation does not specify collision-safe behavior or lock placement.",
    "high: extensions/agent-switchboard.ts:98-103 and src/audio.rs - client and TTS deadlines can trigger fallback while speech is later delivered.",
    "medium: src/api.rs::AudioQueue and finish_audio - stale socket completion lacks reservation cancellation.",
    "medium: src/pbx.rs lifecycle callbacks - quiescing old-leg callback rejection is not explicit.",
    "medium: src/api.rs::status_snapshot - authoritative versus presentation-only ownership is ambiguous."
  ],
  "manualNotes": "Trace bounds, UTF-8 handling, exclusion tests, AppState activity removal, and successful tool-result correlation are explicitly covered, but the findings above require plan revision."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 4m 21s (Total time 4m 20s · 1 turn)[0m