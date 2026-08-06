# Handoff Output: final_review
Status: success
Verdict: REQUEST_CHANGES
Timestamp: 1785995867

## Content
# Review findings

- **High:** `src/models.rs:211-221,297-370` collapses unavailable/malformed catalogs into empty catalogs, then accepts any qualified `provider/model`. This violates the plan’s verification boundary and can launch unverified models.
- **High:** `src/api.rs:344-374` persists and broadcasts transcripts before checking the clip epoch. Pre-rescue speech remains durable and visible despite the intended discard behavior.
- **High:** `src/api.rs:57-59,272-290,853-881` has no audio generation/order metadata; mid-turn speech and reply TTS can arrive out of order. `web/app.ts:726-730` records epochs but does not clear already queued stale audio.
- **High:** `src/pbx.rs:54-104,1068`, `extensions/agent-switchboard.ts:44-50`, and `src/api.rs:709-716` still lack session identity. A late callback from a replaced agent can overwrite current thinking status.
- **High:** `web/app.ts:407-430` sets `isPlaying=false` on pause, then the subsequent `ended` event is rejected by `!isPlaying`; pause-then-ended can leave the clip stuck. `tests/test_app.mjs:90-106` inserts a click before `ended`, so it does not test the race.
- **Medium:** `web/app.ts:835-967` does not block a new recording until the prior recorder’s `onstop` cleanup. Per-recorder chunks prevent mixing, but overlapping microphone streams remain possible.
- **Medium:** `web/app.ts:489-565` uses per-control request generations, not the planned shared in-flight lock. Route, model, and thinking requests can overlap and publish conflicting backend state.
- **Medium:** `src/pbx.rs:289-316` exposes no `models_available` or diagnostic state. An unavailable catalog and a valid empty catalog both render as an empty picker plus fallback, so model-picker availability claims are not observable.

Static output is reported reproducibly rebuilt from `web/app.ts`; the nonzero static diff is expected for the uncommitted generated artifact. Deployment model availability is correctly identified as unverified, but repository fixtures (`openai/gpt-5.6`, `moonshot/luna`, `openai/sol`) are not deployment evidence; local catalog IDs differ.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not-satisfied",
      "evidence": "Verification gates passed, but the review found unresolved audio, transcript, session-callback, picker, catalog, and playback races with concrete source and test evidence."
    }
  ],
  "changedFiles": [
    "package.json",
    "src/models.rs",
    "src/pbx.rs",
    "web/app.ts",
    "static/app.js",
    "tests/test_app.mjs"
  ],
  "testsAddedOrUpdated": [
    "src/models.rs",
    "tests/test_app.mjs"
  ],
  "commandsRun": [
    {"command": "cargo test --locked", "result": "passed", "summary": "50 passed"},
    {"command": "cargo clippy --locked --all-targets -- -D warnings", "result": "passed", "summary": "No warnings"},
    {"command": "python3 -m unittest discover -s legacy/tests", "result": "passed", "summary": "143 passed"},
    {"command": "npm test", "result": "passed", "summary": "Build and browser tests passed"},
    {"command": "git diff --exit-code -- static", "result": "failed", "summary": "Expected uncommitted generated static/app.js change"}
  ],
  "validationOutput": [
    "npm run build reproduced the existing static artifact.",
    "No deployment-host catalog, browser/device, WebSocket, SSH, or production model validation was performed."
  ],
  "residualRisks": [
    "Pre-rescue transcripts and audio can still reach durable history or the caller.",
    "Stale agent callbacks can mutate replacement-leg status.",
    "Unavailable catalogs can authorize arbitrary qualified models and are indistinguishable in status.",
    "The exact deployment model IDs and picker options remain unattested."
  ],
  "noStagedFiles": true,
  "diffSummary": "Browser lifecycle fixes and generated output were added, but planned backend epoch/audio/session protections and explicit catalog availability semantics remain unresolved.",
  "reviewFindings": [
    "high: src/models.rs:211-221,297-370 - unavailable catalogs accept arbitrary qualified models",
    "high: src/api.rs:344-374 - stale transcripts are published before epoch validation",
    "high: src/api.rs:57-59,272-290,853-881 and web/app.ts:726-730 - audio ordering and stale-audio suppression remain unresolved",
    "high: src/pbx.rs:54-104,1068 and extensions/agent-switchboard.ts:44-50 - stale thinking callbacks lack session identity",
    "high: web/app.ts:407-430 and tests/test_app.mjs:90-106 - pause-then-ended playback race is not fixed or tested",
    "medium: web/app.ts:835-967 - new recording is not blocked until prior onstop cleanup",
    "medium: web/app.ts:489-565 - picker requests are not globally serialized",
    "medium: src/pbx.rs:289-316 - catalog availability is not exposed"
  ],
  "manualNotes": "Verification is honest that local pi output is not deployment evidence; fixture model names must not be presented as deployed canonical IDs."
}
```
VERDICT: REQUEST_CHANGES

[38;2;136;136;136m✻ Turn took 3m 19s (Total time 3m 18s · 2 turns)[0m