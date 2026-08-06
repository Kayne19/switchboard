# Handoff Output: review_v2
Status: success
Verdict: REVISE
Timestamp: 1786003809

## Content
# Adversarial review

V2 closes the prior model, lifecycle exposure, failed-speak, documentation, and slice-test placement findings. Remaining blockers:

1. **Critical:** `src/pbx.rs:1234-1252`, `src/pbx.rs:755-756`, `README.md:112-115`  
   `redial(keep_context=true)` reuses the persistent `session_id`, but slice 2 starts the candidate before closing the authoritative process. Two Pi processes can concurrently access the same session file. Define locking, history cloning, or a quiesce/rollback tradeoff, with a test.

2. **High:** `extensions/agent-switchboard.ts:41-58,100-211`, `src/pi_client.rs:220-270`  
   Per-operation `operation_id` and `generation` have no propagation mechanism. The extension receives process-start environment values, while `prompt`/`steer` currently carry only message text. Specify the exact JSONL fields and ExtensionAPI access path; otherwise callbacks cannot carry the required full identity.

3. **High:** `src/pbx.rs:163-190,590-709,1187-1330`  
   Adding `CallLifecycle` “beside” `Switchboard` does not state which existing route/project/session/model fields are removed. Without an explicit transfer of ownership, split lifecycle state remains; wrapping both risks a new god object. Define `Switchboard` as an adapter and `CallLifecycle` as the sole state owner.

4. **High:** `src/api.rs:833-905`, slice 2  
   Candidate startup/intro can invoke speak, diagram, or leg-state callbacks while the prior leg remains authoritative. Specify whether these callbacks are rejected, buffered, or staged, and ensure rejected candidate speech does not suppress fallback synthesis.

Residual risks: callback identity remains correlation rather than authentication; live SSH, STT, TTS, credentials, and rollback still require homelab validation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Four remaining blockers are reported with concrete repository paths, line ranges, failure modes, and required corrections."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Repository inspection",
      "result": "not-run",
      "summary": "Read-only adversarial review."
    }
  ],
  "validationOutput": [
    "Checked revised plan claims against Pi session reuse, callback transport, lifecycle ownership, and candidate adoption paths."
  ],
  "residualRisks": [
    "Callback identity is not authentication.",
    "Live deployment and hardware behavior remain unverified."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed.",
  "reviewFindings": [
    "critical: src/pbx.rs:1234-1252 - candidate redial can concurrently reuse the authoritative persistent session_id.",
    "high: extensions/agent-switchboard.ts:41-58 and src/pi_client.rs:220-270 - per-operation callback identity propagation is unspecified.",
    "high: src/pbx.rs:163-190 - CallLifecycle and Switchboard ownership boundary remains ambiguous.",
    "high: src/api.rs:833-905 - provisional candidate callback side effects lack a defined policy."
  ],
  "manualNotes": "Prior findings are mostly addressed, but these blockers must be resolved before implementation."
}
```

VERDICT: REVISE

[38;2;136;136;136m✻ Turn took 3m 14s (Total time 3m 14s · 2 turns)[0m