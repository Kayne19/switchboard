# Handoff: remove the legacy iframe runtime (collapse the two frontends into one)

This document is the pickup for **option 2** of the "remove dead code / legacy
fallback" work. Option 1 (delete provably-dead code and cruft) is already done —
see the "What option 1 already removed" section at the bottom. Option 2 is a
real port, not a deletion, and is described here for a future session.

---

## ⚠️ FIRST: diagnose and remove the project-specific subagent override

Before doing any option-2 work, deal with this. During the option-1 session a
project-local override was added at:

    .pi/settings.json

```json
{
  "subagents": {
    "agentOverrides": {
      "codebase-analyzer": {
        "extensions": [
          "/home/kayne19/projects/pi-agy-bridge/pi-antigravity/extensions/antigravity.ts"
        ]
      }
    }
  }
}
```

**Why it exists (temporary workaround, not a real fix):** spawning any
subagent in this repo failed at startup because an ambient Pi extension,
`pi-workflow-orchestrator`, was discovered from **two** locations at once and
its tools collided:

- `~/.pi/agent/extensions/pi-workflow-orchestrator/index.ts`
- `/home/kayne19/projects/pi-workflow-orchestrator/dist/src/shared-document-extension.js`

The conflict error was:

    Tool "shared_document_apply"  conflicts with .../shared-document-extension.js
    Tool "shared_document_validate" conflicts with .../shared-document-extension.js
    Tool "shared_document_status"  conflicts with .../shared-document-extension.js

The override sidesteps it by disabling ambient extension discovery for the
`codebase-analyzer` agent and loading **only** the antigravity bridge (so the
`antigravity/gemini-*` models still resolve for read-only gemini scouts).

**What to actually do next session (root-cause, then delete this override):**

1. Find why `pi-workflow-orchestrator` resolves twice. Likely a stale global
   install in `~/.pi/agent/extensions/` shadowing / duplicating the project
   build in `/home/kayne19/projects/pi-workflow-orchestrator/dist/`. Check the
   `packages` list in `~/.pi/agent/settings.json` and the global extensions dir.
2. Remove or de-duplicate whichever copy is wrong so subagents start cleanly
   with the normal ambient extension set.
3. **Delete `.pi/settings.json`** (or at least the `agentOverrides` block) and
   confirm a plain `codebase-analyzer` subagent still starts and can run on an
   `antigravity/gemini-*` model without the override.

Only once subagents start cleanly should option-2 work begin.

---

## The problem option 2 solves

The "new" V17.2 React UI is currently a **skin over the old UI**. It does not
talk to the backend itself — it remote-controls the legacy runtime inside a
hidden iframe and only draws the results.

Traced wiring:

```
static/index.html            → V17.2 React bundle (main.tsx → App.tsx)   [the visible UI]
  └─ <RuntimeIntegration/>    apps/frontend/src/integration/runtime.tsx
       └─ <iframe src="/legacy/index.html?runtime=1">                     [hidden: 1×1, opacity:0]
            └─ static/legacy/index.html loads /app.js and /diagram.js
                 └─ apps/frontend/src/app.ts   (legacy entry)
                      ├─ protocol.ts   WebSocket framing + STT headers
                      ├─ hands_free.ts → /vad-worklet.js (AudioWorklet VAD)
                      ├─ wake_word.ts  → wake_detector.ts (OpenWakeWord WASM/ONNX)
                      ├─ stage.ts, diff.ts, synchro.ts   (legacy DOM drawing)
                      └─ diagram.ts
```

The two sides talk only over `postMessage`, using the source tags
`switchboard-legacy-runtime` (legacy → React) and `switchboard-v17`
(React → legacy). Both ends live in:

- React side: `apps/frontend/src/integration/runtime.tsx`
  (`LEGACY_SOURCE`, `V17_SOURCE`)
- Legacy side: `apps/frontend/src/app.ts`

**Goal of option 2:** make the React app open the backend connection itself,
run audio/voice natively, and delete the hidden iframe plus the legacy runtime.

---

## What must be reimplemented in React (the actual work)

These are the load-bearing subsystems the legacy runtime provides today. Each
must exist natively in the React app **before** the legacy files can be deleted:

1. **WebSocket + protocol framing** — backend connection management, JSON
   payload parsing, binary framing.
   Today in: `apps/frontend/src/app.ts`, `apps/frontend/src/protocol.ts`
   (`sttStartHeader`, `sttChunkHeader`, `sttEndHeader`).
2. **Audio capture + VAD** — `getUserMedia`, `AudioContext`, voice-activity
   detection via `AudioWorklet`, playback muting.
   Today in: `apps/frontend/src/hands_free.ts`, `apps/frontend/src/vad-worklet.ts`.
3. **STT streaming** — buffer encoding via the protocol headers above.
   Today in: `apps/frontend/src/app.ts`, `apps/frontend/src/protocol.ts`.
4. **Wake word** — local OpenWakeWord WASM/ONNX inference.
   Today in: `apps/frontend/src/wake_word.ts`, `apps/frontend/src/wake_detector.ts`,
   assets under `static/openwakeword/*`.

### What does NOT need porting

The visual/DOM manipulation in `diff.ts`, `diagram.ts`, `stage.ts`, and
`synchro.ts` is already re-expressed by React primitives and can be dropped
outright once the runtime is native — do **not** port them:

- `DiagramPrimitive`, `CodeViewport`, `VoiceIndicator`, `SceneRenderer`, etc.
  under `apps/frontend/src/components/` and `apps/frontend/src/primitives/`.

The React side already knows how to consume every server message: see the
`handleServer` switch in `apps/frontend/src/integration/runtime.tsx`
(`epoch`, `history`, `transcript`, `spoken`, `reply`, `thinking`, `activity`,
`diagram`, `view`, `error`). Reuse that mapping; just feed it from a native
WebSocket instead of the iframe `postMessage` bridge.

---

## Suggested sequence (rollback-safe)

1. Add a native transport module in React (WebSocket + protocol) behind a flag,
   still defaulting to the iframe bridge.
2. Port audio capture / VAD, then wake word, verifying voice end to end against
   the running Rust backend.
3. Switch `RuntimeIntegration` to the native transport; keep the iframe as a
   fallback for one commit.
4. Once verified, delete the iframe, `RuntimeIntegration`'s legacy branch, and
   the legacy files below.

### Files to delete at the end of option 2 (NOT before)

Source: `apps/frontend/src/app.ts`, `protocol.ts`, `hands_free.ts`,
`vad-worklet.ts`, `wake_word.ts`, `wake_detector.ts`, `stage.ts`, `diff.ts`,
`synchro.ts`, `diagram.ts`.

Built output: `static/legacy/index.html`, `static/app.js`, `static/protocol.js`,
`static/hands_free.js`, `static/vad-worklet.js`, `static/wake_word.js`,
`static/wake_detector.js`, `static/stage.js`, `static/diff.js`,
`static/synchro.js`, `static/diagram.js` (and, if wake word is replaced,
reassess `static/openwakeword/*`).

### Tests that will need updating (they currently pin the legacy modules)

- Node AST tests: `apps/frontend/tests/test_app.mjs`, `test_protocol.mjs`,
  `test_hands_free.mjs`, `test_stage.mjs`, `test_diagram_waves.mjs`.
- V17 tests to extend for the native path: `tests/integration/bridge.spec.ts`,
  `tests/visual/runtime.spec.ts`, `tests/unit/*`.

### CI gates that must stay green

- `npm test` followed by `git diff --exit-code -- static` — the compiled
  browser output is committed, so **rebuild `static/` in the same change** or
  the diff gate fails.
- Rust gates are unaffected by this work but still run:
  `cargo fmt --all -- --check`, `cargo test --locked`,
  `cargo clippy --locked --all-targets -- -D warnings`.
- Python compatibility gate is unrelated: `python3 -m unittest discover -s legacy/tests`.

### Backend note

The Rust backend serves `static/` via `ServeDir` (`apps/backend/src/main.rs`)
and still exposes the routes the legacy runtime uses (e.g. `/view`,
page-control endpoints in `apps/backend/src/api.rs`). The native React
transport should hit the **same** routes/WebSocket — no backend protocol change
is required to remove the iframe. Revisit backend routes only if a specific
endpoint becomes unused after the port.

---

## What option 1 already removed (context)

- Deleted `apps/frontend/MIGRATION_CHECKLIST.md` (a completed-cutover checklist)
  and its two references in `apps/frontend/AGENTS.md` and
  `apps/frontend/README.md`.
- Removed dead legacy-fallback code in `apps/backend/src/prewarm.rs`: the
  never-constructed `PrepareSource::Legacy` enum variant and the write-only
  `_pi_binary` field on `PrewarmInner`. All Rust gates pass.

Deliberately left alone (not dead): the `legacy/` Python tree (the documented
compatibility baseline with its own CI tests) and the entire legacy iframe
runtime (load-bearing until option 2 lands).

### Considered but skipped, with reasons

- `apps/frontend/src/app/sceneModel.ts` `orderedObjects` is exported but only
  used within its own file. Dropping the `export` is cosmetic and would force a
  full hashed-bundle rebuild under the `git diff --exit-code -- static` gate for
  zero runtime benefit. Fold it into a future frontend change instead.
- Stale handoff docs `docs/extraction-plan.md` and
  `docs/rust-typescript-migration-handoff.md` describe now-completed work. They
  are documentation, not code, so they were left for a human to retire
  deliberately rather than deleted in a dead-code pass.
