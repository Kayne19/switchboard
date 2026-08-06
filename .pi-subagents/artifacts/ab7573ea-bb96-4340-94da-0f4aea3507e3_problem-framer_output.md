# Problem brief

**Outcome:** The browser must maintain one recording stream per turn, play each reply once in FIFO order, advance to the next clip when the current clip reaches its end, survive runtime/race failures, and expose only models present in the authoritative project catalog.

**Constraints:** Preserve clip IDs and turn generation/epoch checks. Do not fabricate model choices. Operator model changes remain unavailable. No deployment configuration is inferred from repository code.

**Assumptions:** “Skip-to-end” means seeking the native `<audio>` player to its duration and triggering `ended`. “GPT 5.6”, “Luna”, and “Sol” are human-requested names; their exact provider-qualified IDs must come from deployment catalog output.

## Acceptance criteria

1. **No duplicate recording streams**  
   Given rapid repeated Talk clicks, including while microphone permission is pending, only one `MediaStream` and `MediaRecorder` may exist. Every stop, cancel, constructor failure, and permission failure must stop all tracks and leave the UI recoverable.  
   **Repository verification:** `web/app.ts:73-87, 798-916`; add/browser-test the lifecycle. Backend retransmission of one clip ID must remain idempotent at `src/api.rs:1048-1106`.

2. **FIFO playback and skip behavior**  
   Given queued clips A then B, ending or seeking A to its end must remove A exactly once and begin B. A must not be requeued or replayed. Pause, decode error, autoplay rejection, and stale-generation cancellation must not accidentally replay the current item.  
   **Repository verification:** `web/app.ts:363-430, 774-784`; test the real queue/event behavior, not only protocol serialization.

3. **Runtime errors and races are bounded**  
   Unhandled `play()`, fetch, recorder, WebSocket, or permission failures are prohibited. Concurrent route/model/thinking operations must not publish stale status, stale transcript, stale audio, or duplicate reconnect work. The UI must show an actionable error and remain usable.  
   **Repository verification:** `web/app.ts:585-705, 798-916`; `src/api.rs:510-705, 806-880`; generation/operation guards must be covered by deterministic tests.

4. **Model picker contract**  
   On a project leg, the picker must display the provider-qualified entries delivered by status (`provider/model`), retain the current model when catalog data is unavailable, disable itself when swaps are disabled, and surface failed `/model` requests without corrupting the current selection.  
   **Repository verification:** `src/pbx.rs:276-316, 1098-1112`; `src/api.rs:660-705`; `web/app.ts:476-488, 913-916`; `static/app.js` must match the TypeScript build.

5. **Requested models are deployment-attested, not invented**  
   GPT 5.6, Luna, and Sol are accepted as visible only when the relevant project host’s `pi --list-models` output contains their canonical entries and the runtime/provider credentials can start them. For remote projects, verify on the remote host selected by `src/pi_client.rs:753-766`, not on the switchboard host.  
   **Outside-repository verification:** capture catalog output, project registry/runtime, provider configuration, and a live picker screenshot or API payload. These names do not appear in repository configuration, so source inspection alone cannot prove availability.

## Findings and residual risks

- **High:** `src/models.rs:211-220` permits any provider-qualified model when catalog discovery fails; `src/pbx.rs:1098-1112` then passes it toward process startup. This prevents proving that a selected model is available.
- **Medium:** `tests/test_protocol.mjs` does not exercise `web/app.ts` audio queue/event behavior, so duplicate-stream and skip-to-next claims require browser-level coverage.
- Deployment catalog contents, credentials, SSH reachability, and actual model availability cannot be verified from this repository.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete acceptance criteria cover duplicate streams, skip-to-next semantics, runtime races, model picker behavior, deployment boundaries, and file-path evidence."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Inspected web/app.ts, src/api.rs, src/pbx.rs, src/models.rs, src/pi_client.rs, tests/test_protocol.mjs, and static/index.html."
  ],
  "residualRisks": [
    "Catalog failure still permits arbitrary provider-qualified model passthrough.",
    "Repository tests do not exercise browser audio playback events.",
    "GPT 5.6, Luna, and Sol availability depends on external host catalogs and credentials."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed.",
  "reviewFindings": [
    "high: src/models.rs:211-220 - empty catalog allows unverified provider-qualified models",
    "medium: tests/test_protocol.mjs - no end-to-end audio queue or duplicate-stream coverage"
  ],
  "manualNotes": "Deployment verification must run pi --list-models on each authoritative project host."
}
```

[38;2;136;136;136m✻ Turn took 1m 51s (Total time 1m 50s · 1 turn)[0m