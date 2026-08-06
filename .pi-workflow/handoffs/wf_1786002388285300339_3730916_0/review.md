# Handoff Output: review
Status: success
Verdict: REVISE
Timestamp: 1786003456

## Content
# Adversarial review

1. **High:** `src/models.rs:216-230` rejects provider-qualified models when the catalog is unavailable, contrary to `legacy/backend/models.py:198-214` and the migration contract. “Model compatibility tests” is not a correction. Fix this in the model slice and pin passthrough behavior.

2. **High:** The proposed atomic adoption is underspecified. `src/pbx.rs:636-663` and `1248-1264` drop the old leg and mutate visible route fields before startup and intro completion. Define provisional-candidate ownership, the exact commit point, intro-failure behavior, and whether failure preserves the old leg or returns to the operator. Add rescue-during-setup tests in slice 2, not slice 6.

3. **High:** Identity correlation is incomplete. `SWITCHBOARD_SESSION_TOKEN` is derived from the persistent `session_id`, which redial intentionally reuses; it cannot distinguish old and new processes. `/speak` and `/diagram` currently carry no identity (`extensions/agent-switchboard.ts`, `src/api.rs:833-913`). Rotate a per-process leg token separately from the persisted Pi session ID, propagate operation identity, and validate every callback before transcript, audio, diagram, or status mutation.

4. **High:** “Switchboard is sole owner” conflicts with retaining API-owned `turn_generation`, `operation_transition`, `active_session`, and cancellation state (`src/api.rs:30-54`). The plan needs explicit coordinator command/query APIs and one linearization boundary; otherwise it adds a state-machine façade over the same split ownership. Do not await broadcaster callbacks while holding coordinator state.

5. **High:** Slice 4 says lifecycle events will be serialized onto WebSocket, while the plan simultaneously lists public-vs-diagnostic exposure as unresolved. Decide that contract first. Define atomic state/event commit, sequence allocation, journal retention, replay/lag behavior, and ordering relative to `epoch → status → history → diagram`. Sanitization needs an allowlist and size limits, not merely the word “sanitized.”

6. **Medium-high:** Post-prompt `same_session()` checks alone are insufficient. Transfer, redial, startup, and callback paths contain additional awaits and side effects. Validate identity immediately before every route/session/history/audio/diagram commit. Move those race tests into the slices that introduce the checks.

7. **Medium:** The first slice’s `announce_route` callback can only trace route snapshots, not preparation, startup, intro, cancellation, terminal outcomes, or shutdown. It cannot establish the promised canonical lifecycle trace without a coordinator transition seam. Each slice needs its own executable exit tests instead of deferring critical validation to “coverage completion.”

8. **Medium:** The known failed-`speak` behavior still suppresses fallback synthesis (`src/pi_client.rs:367-454`, `src/pbx.rs:1459`; documented in `docs/observability-and-coverage-handoff.md:61-74`). Either fix it based on tool completion/error, or explicitly mark the README-promised fallback as an accepted non-goal with a regression test.

9. **Medium:** New identity/logging variables must be documented as public contracts. `SWITCHBOARD_LOG` and `SWITCHBOARD_LOG_FORMAT` are already missing from `docs/rust-typescript-migration-handoff.md`; the token contract is also absent. The plan must require the corresponding homelab PR and must not imply deployment from this repository.

Residual risk remains around restart semantics, callback spoofing (identity prevents stale work but is not authentication), and live STT/SSH validation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only adversarial review identified concrete corrections with severity and repository evidence across lifecycle ownership, adoption, identity, model compatibility, event contracts, testing, and deployment."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository and handoff inspection",
      "result": "not-run",
      "summary": "Review-only task; no tests or source changes."
    }
  ],
  "validationOutput": [
    "Compared the plan with switchboard and adjacent repository instructions, source/docs, and reference, switchboard, and compare handoffs."
  ],
  "residualRisks": [
    "Restart durability and lifecycle-event exposure remain product decisions.",
    "Callback identity is not authentication.",
    "Live STT, SSH, credentials, and rollback behavior remain unverified."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; adversarial plan review only.",
  "reviewFindings": [
    "high: src/models.rs:216-230 - unavailable catalogs violate provider-qualified passthrough compatibility.",
    "high: src/pbx.rs:636-663,1248-1264 - atomic adoption and rollback semantics are underspecified.",
    "high: extensions/agent-switchboard.ts and src/api.rs:833-913 - callback identity cannot currently reject stale process callbacks.",
    "high: src/api.rs:30-54 - coordinator ownership remains contradicted by API-owned lifecycle state.",
    "high: plan slice 4 - public WebSocket lifecycle exposure is unresolved but treated as implementation scope.",
    "medium-high: stale checks are deferred too late and are incomplete across awaited transition paths.",
    "medium: failed speak suppresses fallback synthesis and lacks a firm scope decision.",
    "medium: public environment-contract documentation is incomplete."
  ],
  "manualNotes": "The plan has a sound direction but requires these corrections before implementation.",
  "notes": "Review verdict is revision-required."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 30s (Total time 3m 29s · 2 turns)[0m