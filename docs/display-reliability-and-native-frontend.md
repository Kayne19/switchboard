# Display reliability and the native frontend

Status: **complete.** Both halves have shipped.

| Phase | What | Commits |
|-------|------|---------|
| 1 | Display reliability: render confirmation, honest `display`/`view` results, scoped schema errors | `879a1aa`…`fe2255f`, merged in `c17a2db` |
| 2–4 | Native call runtime (socket, push-to-talk, playback, hands-free, wake word) behind `?native` | `4c868b5` |
| 5a | Native runtime made the default; iframe kept one commit behind `?legacy` | `a05e559` |
| 5b | Iframe bridge, legacy page, and legacy runtime deleted | `3400dcf` |

This spec did two things in one sequence:

1. Made the `display`/`view` agent tools tell the truth about what is on the
   caller's screen (the three problems logged in `DISPLAY_EXTENSION_ISSUES.md`).
2. Deleted the legacy iframe runtime so the V17.2 React app talks to the backend
   directly.

Phase 1 delivered the display fix over the iframe path first, so the reported
bug was fixed before the rewrite began, and the rewrite then proceeded with the
display path already covered by tests. The confirmed-render contract is
documented, authoritatively, in `docs/visual-channel.md`; this file records the
design and the decisions behind it. File and line references in the problem
analysis below describe the code as it was when the problems were traced.

---

## The problems (verified against the code)

`DISPLAY_EXTENSION_ISSUES.md` logs three hardships. Each was traced to a root
cause, not taken at face value.

### 1. Schema-validation confusion

The agent's intuitive `type: "diagram"` payloads were rejected with errors that
named chart/metric fields (`series`, `label`, `value`) even though `type` was
`diagram`.

**Root cause:** the tool schema `DisplayActionType` in
`extensions/agent-switchboard.ts:491` is an **undiscriminated** `Type.Union`.
When pi validates the tool call locally, a union failure reports every branch's
requirements at once, so a bad `diagram` surfaces chart/metric requirements. The
Rust validator (`apps/backend/src/visual_protocol.rs`) is *not* the culprit — it
already returns targeted per-type errors such as `diagram.mode must be "graph"`.
The dense one-paragraph tool description (`agent-switchboard.ts:508`) also never
states the required shape per type.

### 2. Backend reports success; nothing renders

A valid diagram returned `"On screen."` but the caller saw nothing.

**Root cause:** in `display()` (`apps/backend/src/api.rs:1925`), `delivered` is
`true` when the event is merely *queued* to a connected WebSocket channel
(`publish_sequenced`, api.rs:328). It means "handed to a socket buffer," not
"received," and never "rendered." The served page is the V17.2 React app
(`static/index.html` -> `/v17-assets/...`), which *does* handle `case "display"`
(`apps/frontend/src/integration/runtime.tsx:240`). But:

- If `validateControllerAction` returns `!ok`, the action is **silently dropped**
  (no `else` branch at runtime.tsx:242) — invisible to the agent and to logs.
- Display frames reach React through the legacy iframe bridge
  (backend WS -> `app.ts` -> `postMessage` -> `handleServer`). `postMessage` is
  not buffered, so a frame arriving before React's listener mounts is lost.

### 3. `view` reports a screen state that never matched reality

`view` said "auto view with **chart**" after a diagram was requested, while the
caller saw nothing.

**Root cause:** `view` (no target) returns `gate.screen_state`
(`apps/backend/src/api.rs:1979`), which is written *only* by the browser's own
`screen_state` WS report (api.rs:2636) or marked `stale` on route change. The
`display` handler updates `gate.projection` and `gate.watermark` (api.rs:1927)
but never `screen_state`. So `view` echoes the browser's last self-report; if the
diagram never rendered (problem 2), the browser never reported "diagram," and
`view` keeps returning the prior "chart" while reporting `connected: true`. A
`watermark` (what the agent asked to show) and a browser report (what rendered)
both exist, but nothing reconciles them.

### Underlying structural issue (the rewrite half)

The V17.2 React UI was a skin over the legacy runtime: it remote-controlled a
hidden `<iframe src="/legacy/index.html">` that owned the WebSocket, audio, and
wake word, and only drew the results. The iframe `postMessage` hop was the
source of the mount race in problem 2 and was dead weight once React could open
the socket itself.

---

## Goals and non-goals

**Goals**

- `display` reports the truth: on screen only when the browser confirms it
  rendered the specific action; otherwise a specific, actionable reason.
- A browser-side rejection is never silent — it becomes a tool error the agent
  can act on and a log line an operator can find.
- `view` distinguishes *requested* from *confirmed on screen*.
- The agent's first reasonable `display` payload validates; a wrong one gets an
  error scoped to the type it chose.
- The React app owns its backend connection; the legacy iframe and runtime are
  deleted.

**Non-goals**

- No new agent-facing operations. The six-operation protocol
  (`show/hide/say/focus/clear` + `view`) stays; `apps/frontend/AGENTS.md` forbids
  adding operations without proving composition cannot express the behavior.
- No new `SWITCHBOARD_*` environment variable (the confirmation deadline is a
  code constant), so no homelab interface change is required.
- No change to what the visuals *look like*; the design system and glyph geometry
  are untouched (`apps/frontend/AGENTS.md` visual-regression policy applies).

---

## Design

Problems 1–3 are Phase 1 and are architecture-independent (they live in the
backend and in the frontend files the rewrite keeps: `protocol.ts`,
`runtime.tsx` `handleServer`, the controller). The rewrite is Phases 2–5.

### Part A — end-to-end render acknowledgment (problem 2)

The browser confirms the *specific* thing it rendered, and never drops silently.

**A1. Thread a sequence through the wire.** The backend already computes a
per-event `sequence` (`publish_sequenced`, api.rs:328) and stores it as
`gate.watermark` (api.rs:1928) but never sends it. Broadcast it:

```
{ "type": "display", "seq": <u64>, "action": <normalized action> }
```

The reconnect snapshot (`register_connection` -> `snapshot_actions()`,
api.rs:501/508) carries the current watermark too, so a late-mounting tab can ack
the scene it was handed.

**A2. Browser acks what it applied, and nacks what it rejected.** In
`runtime.tsx` `case "display"` (line 240): on success, record the highest applied
`seq`; add the missing `else` branch for `!result.ok`. Both travel back inside the
*existing* `screen_state` report (`protocol.ts:34` `screenStateMessage`), extended
with:

```
applied_seq: <u64>            // highest display seq this browser has rendered
rejected?: { seq: <u64>, reason: <string> }   // set when an action failed validation
```

Reusing the `screen_state` report means no new bridge command and no new WS
message type — the report is already forwarded React -> legacy -> backend today
(`runtime.tsx:107` `command("screen_state", report)`), and directly in native
mode later.

**A3. Backend waits briefly for confirmation.** Add to `AppInner` a
`watch::Sender<(u64 /*generation*/, u64 /*confirmed_seq*/)>` (the *confirmed
watermark*). The `screen_state` handler (api.rs:2564) updates it from
`applied_seq` under the current generation; a `rejected` field records the reason
against `rejected.seq`. `display()`:

1. validates, publishes, reads its `seq`, sets `gate.watermark`, **releases the
   gate lock** (never await while holding it);
2. awaits the confirmed-watermark watch up to a bounded deadline
   (`DISPLAY_CONFIRM_DEADLINE_MS`, a module constant ~2500ms, well under the
   extension's 30s fetch timeout);
3. re-validates the leg/generation on wake (`accept_side_effect`, matching the
   existing re-check at api.rs:1908).

Response shapes:

| Condition | Response |
|-----------|----------|
| confirmed `seq` for this generation | `{ "delivered": true, "rendered": true }` |
| rejected by browser for this `seq` | `{ "delivered": true, "rendered": false, "rejected": true, "reason": "<why>" }` |
| queued to a live socket, no confirmation before deadline | `{ "delivered": true, "rendered": false, "reason": "no confirmation from the browser" }` |
| no browser connected | `{ "delivered": false, "reason": "no browser connected" }` |

**A4. Generation scoping (concurrency).** Per
`docs/concurrency-and-test-hazards.md`, a route change already clears the
projection, marks `stale`, and resets `report_epoch`/`report_generation`
(api.rs:641–647). Reset the confirmed watermark there too and bump the watch so a
`display()` awaiting from a retired leg wakes and returns unconfirmed/invalid-leg.
An ack tagged with an old generation never confirms a new leg's action.

**A5. Extension tells the truth.** `agent-switchboard.ts` `display.execute`
(line 511) maps the response to honest text:

- `rendered: true` -> `"On screen."`
- `rejected` -> `"The caller's screen rejected it: <reason>. Try a different payload."`
  (returned as `isError: true` so written fallback stays eligible)
- delivered but unconfirmed -> `"Sent, but the caller's screen has not confirmed it — it may not be visible. It will appear if they have the page open."`
- not delivered -> unchanged ("Nobody is looking: ...").

### Part B — `view` reports intent and confirmation (problem 3)

`view` (no target) stops echoing only the browser's self-report. It reports
backend-owned *intent* plus a *confirmation* flag.

- Add `projection.summary()` -> `{ has_visual, visual_kind, title, object_ids }`,
  computed from `gate.projection` (what the agent asked to show), using the same
  role/precedence rule the frontend uses in `apps/frontend/src/app/sceneModel.ts`
  to choose the primary visual.
- Add `confirmed = report_watermark >= watermark && report_generation == current_generation`.
- `view` returns the projection summary, `confirmed`, and `connected`.

`agent-switchboard.ts` `view.execute` (line 567) then reports, e.g.,
`"Showing a diagram titled '…'."` when confirmed, versus `"Requested a diagram
'…'; not yet confirmed on the caller's screen."` when not.

To keep the projection summary and `sceneModel` from drifting (both must agree on
which object is "the visual"), the precedence rule is documented once in
`docs/visual-channel.md` and both sides cite it.

### Part C — discriminated schema and a description that shows shapes (problem 1)

In `extensions/agent-switchboard.ts`:

- First, **reproduce the exact validation error** to confirm it originates in
  pi's local TypeBox validation (the evidence points there; the Rust validator is
  already clean). This decides the precise mechanism.
- Convert `DisplayActionType` (line 491) to a **discriminated union** keyed on
  `op`, with the `show` branch discriminated on `type`, so a bad `diagram`
  reports only diagram requirements. If pi's bundled TypeBox lacks clean
  discriminated-union errors, fall back to: keep the union but enrich the
  description and add explicit per-type guidance so the first attempt validates.
- Tighten the `display` description (line 508) with a one-line shape per type,
  e.g. `diagram: { mode:"graph", nodes:[{id,label}], edges:[{from,to}] }`.
- Keep a single `display` tool (six-op protocol; tool defs are expensive context
  on project hosts — see the file header at `agent-switchboard.ts:1`).

### Parts D–G — the native frontend (Phases 2–5)

Before this work the V17.2 React UI remote-controlled a hidden
`<iframe src="/legacy/index.html">` that owned the WebSocket, microphone,
playback, and wake word; React only drew what the iframe relayed over
`postMessage`. The React app now runs the call itself.

`apps/frontend/src/runtime/` is a port of the legacy runtime's non-DOM logic,
not a redesign. Control flow, guards, and status wording were carried over;
DOM writes became explicit state. It owns no DOM and reports through two
callbacks, `onState` (runtime state) and `onServer` (every decoded backend
message).

| Module | Owns |
|--------|------|
| `callRuntime.ts` | socket generations, `hello`, heartbeat (20 s ping, 8 s pong deadline), reconnect (1.5 s), epoch and transfer-era handling, the clip outbox flush, serialized route/model/thinking requests, hangup, the response barrier, hands-free wiring |
| `pushToTalk.ts` | the recorder lifecycle, epoch/transfer stamping at record start, streaming STT frames |
| `audioPlayback.ts` | single-owner replay, per-utterance MediaSource streaming, the complete-replay fallback, gesture resume |
| `outbox.ts` | outbox caps, resend-after-reconnect, the transfer-era re-stamp rule |
| `lineStatus.ts` | `status` event → line and picker state (pure) |

Kept unchanged and now bundled or loaded by the React page: `protocol.ts`
(wire framing), `hands_free.ts` (the hands-free controller and VAD
endpointing), `wake_word.ts` and `wake_detector.ts` (the local wake-word
adapter), `vad-worklet.ts` (built to `/vad-worklet.js` and loaded by URL).

`src/integration/runtime.tsx` creates one `CallRuntime` per page, routes
`onServer` into the same `handleServer` switch Phase 1 extended, and sends
screen-state reports through `sendScreenState`. Because Part A's ack path lives
in `handleServer` and `protocol.ts`, it runs unchanged on the native path, and
the `postMessage` mount race from problem 2 is gone structurally.

## Delivery record

### Phase 0 — preconditions and baseline

The green baseline was confirmed before each half. The `.pi/settings.json`
subagent override was listed here as a precondition for the rewrite; the
rewrite did not need pi subagents, so it was not addressed and the override is
still in place (see open items).

### Phase 1 — display reliability (shipped over the iframe path)

- Backend: Parts A1, A3, A4 (`api.rs` seq threading, confirmed watermark,
  bounded wait) and Part B (`view` reconciliation, `projection.summary()`).
- Frontend: Part A2 (`protocol.ts` `applied_seq`/`rejected`; `runtime.tsx`
  records what it applied and reports what it rejected).
- Extension: Parts A5, B, C (`agent-switchboard.ts`).
- `DISPLAY_EXTENSION_ISSUES.md` folded into `docs/visual-channel.md`; the log is
  marked resolved.

### Phases 2–4 — native runtime behind `?native` (`4c868b5`)

Transport, push-to-talk, playback, and hands-free/wake word landed together
behind the flag, since each was a port of existing code rather than new
behaviour and the iframe stayed the default. The legacy regression suite
(`test_app.mjs`) was ported to vitest against the new modules before anything
was deleted, and the Phase 1 display-ack flow was re-run on the native path in
Playwright.

### Phase 5 — cutover (`a05e559`) and deletion (`3400dcf`)

The native runtime became the default with `?legacy` as a one-commit fallback,
then the iframe, the `postMessage` bridge, the legacy page, `app.ts`,
`synchro.ts`, and their built output were deleted. `test_app.mjs` was retired
in the deletion commit; `test_protocol.mjs` already targeted the retained
`protocol.ts`.

## Wire-protocol changes (concrete)

Backend -> browser, display event (adds `seq`):

```json
{ "type": "display", "seq": 42, "action": { "op": "show", "id": "...", "type": "diagram", "data": { ... } } }
```

Browser -> backend, `screen_state` report (adds `applied_seq`, optional
`rejected`):

```json
{ "type": "screen_state", "view": "auto", "has_visual": true, "visual_kind": "diagram",
  "title": "...", "stale": false, "generation": 7, "object_ids": ["..."],
  "applied_seq": 42, "rejected": { "seq": 41, "reason": "diagram.mode must be \"graph\"" } }
```

`/display` and `/view` responses gain `rendered` / `rejected` / `confirmed` as
described in Parts A3 and B. No route is added or removed.

---

## Testing (all offline — no network, ElevenLabs, or whisper)

- **Backend (Rust):** `register_connection()` fakes a browser. `/display`
  reports `rendered:false` before an ack and `rendered:true` after a
  `screen_state` with `applied_seq >= seq`; a `rejected` report yields
  `rendered:false, rejected:true` with the reason; a route change between
  publish and ack invalidates a stale ack; `view` reports the projection's
  `visual_kind` and `confirmed` for unconfirmed and confirmed scenes.
- **Frontend unit (vitest, in `npm test`):** `validation`, `sceneModel` (the
  precedence rule shared with `projection.summary()`), `reportDispatch` (the
  rejection survives queueing), and the runtime suites — `callRuntime`
  (socket lifecycle, heartbeat, reconnect, dispose, epochs and transfers,
  outbox resend, serialized line requests, hands-free wiring), `pushToTalk`,
  `audioPlayback`, `outbox`, `lineStatus`. The last four carry the ported
  legacy regressions.
- **Node (`npm test`):** `test_protocol.mjs` (wire framing),
  `test_extensions.mjs` (honest `display`/`view` text, discriminated schema),
  `test_hands_free.mjs` (controller, wake adapter, worklet, the page's import
  map, no ONNX Runtime in the bundle).
- **Playwright (not in `npm test`):** `tests/integration/callRuntime.spec.ts`
  runs the production build against a fixture WebSocket: replay, display ack
  and nack, view, generation change, push-to-talk through Chromium's fake
  microphone, and reconnect. `tests/visual/runtime.spec.ts` drives the
  semantic scenes through the same fixture socket; `visual.spec.ts` holds the
  goldens, which this work did not change.
- **Checked by hand, not committed:** the native page against the real Rust
  backend (a local run with a stub STT command) completed hello, snapshot,
  screen-state acks, and a push-to-talk clip through `accepted` →
  `transcript` → an operator turn (pi stubbed out), with no browser console
  errors; and the wake-word engine,
  ONNX models, and VAD worklet loaded in Chromium through the import map.

## CI gates (green every commit)

`cargo fmt --all -- --check`, `cargo test --locked`,
`cargo clippy --locked --all-targets -- -D warnings`,
`python3 -m unittest discover -s legacy/tests`, and `npm test` followed by
`git diff --exit-code -- static`. Every frontend-source commit rebuilds `static/`
in the same commit.

## Cross-repo / deployment notes

- No `SWITCHBOARD_*` variable is added; the confirmation deadline is a code
  constant. No homelab PR is required for correctness here.
- The `agent-switchboard.ts` change reaches project hosts via the extension
  staging path (`pbx.Switchboard._stage_extension`), not a deploy — it is not
  live on a host until staged.
- The Rust backend protocol *does* change (adds `seq`/`applied_seq`/`rendered`).
  These display changes are additive and backward-tolerant (a browser that
  omits `applied_seq` simply stays "unconfirmed").
- The rewrite needed no backend or protocol change: the native runtime uses the
  same `/ws` socket and HTTP routes the iframe did. What it removes is served
  files — `/legacy/index.html`, `/app.js`, `/protocol.js`, `/hands_free.js`,
  `/wake_word.js`, `/wake_detector.js`, `/synchro.js` — so a bookmark to
  `/legacy/` stops working. `/vad-worklet.js` and `/openwakeword/*` are still
  served and still required.

---

## Decisions and rejected alternatives

- **End-to-end render ack** chosen over honest-wording-only. Honest wording alone
  ("queued to a connected browser") would stop the false "On screen." but would
  not make a real render failure recoverable. The ack makes the agent able to
  redraw and makes failures observable — the profile's diagnosis default.
  Revisit if the bounded wait proves too costly per call.
- **One combined effort** chosen over shipping the display fix first and
  sequencing the rewrite separately. Tradeoff accepted: the combined spec is
  larger and Phases 2–5 are weeks of work, while the reported bug is solved at
  Phase 1. Mitigation: Phase 1 is independently shippable inside this plan, so
  the bugfix does not wait for the rewrite. Revisit by splitting at the Phase 1/2
  boundary if the rewrite stalls.
- **Nack folded into the `screen_state` report** rather than a new WS message or
  bridge command — avoids touching the bridge command set, which is about to be
  deleted anyway.
- **Single `display` tool kept** — the six-op protocol constraint and the cost of
  tool definitions on project hosts both argue against splitting.
- **Deadline as a constant**, not an env var — avoids a cross-repo interface
  change for a value that does not need per-deployment tuning.
- **Port, then delete** — the native runtime is a behaviour-preserving port of
  the legacy runtime's logic with its regression tests carried over, not a
  redesign. A move is reviewable against the old code; a rewrite-plus-move is
  not. Simplifying `callRuntime.ts` further is a separate, later change.
- **The runtime owns no DOM** — it reports state and messages through callbacks
  and the React adapter renders them, so the runtime is testable with fake
  sockets and recorders and the design system stays the only presentation.
- **Wake-word assets stay out of the bundle** — Vite marks
  `openwakeword-wasm-browser` external and the page's import map resolves it
  and `onnxruntime-web` to the committed `/openwakeword/` files. Letting Vite
  bundle them pulled in ONNX Runtime's full build and a 26.8 MB WASM file.
- **The worklet stays a tsc build at `/vad-worklet.js`** — an AudioWorklet is
  loaded by URL, and the committed file is unchanged by this work.
- **No new call chrome** — the approved design exposes only the Damocles
  presence, so the rewrite added no controls. The runtime's full command set
  (`toggleHandsFree`, `selectRoute`, `selectModel`, `selectThinking`, `hangup`)
  exists and is tested but is not reachable from the page; see open items.

## Open items

- **Hands-free, line pickers, and hangup have no on-page control.** The
  legacy page was the only UI for them; the V17 design exposes only the
  Damocles presence (start/send a turn, or reconnect). The runtime implements
  all of them. Exposing any is a design decision under
  `apps/frontend/AGENTS.md`, not a transport change.
- **Space-to-talk is gone.** The legacy page bound Space and Escape to
  push-to-talk; inside the hidden iframe those bindings never received focus,
  so V17 already lacked them. Not restored.
- **Unverified: a transfer-era clip that is already on the wire is not
  resent.** The port keeps the legacy rule: on the epoch that ends a transfer,
  clips recorded during it are re-stamped, but only *unsent* clips are flushed.
  A clip sent under the old generation while the candidate was still starting
  waits for the backend's answer instead. Whether the backend delivers or
  discards such a clip has not been checked.
- **`.pi/settings.json`** (the subagent override from Phase 0) is still in the
  working tree, untracked. The rewrite did not depend on it.
- **`docs/extraction-plan.md` and `docs/rust-typescript-migration-handoff.md`**
  were slated for retirement at cutover. They were left: `AGENTS.md` still
  cites the extraction plan for the homelab pinned-tag switch, which is outside
  this work.
- **Remaining design risks from Phase 1:** `projection.summary()` and
  `sceneModel` are still two implementations of the precedence rule (both
  tested against it); `/display` still waits up to ~2.5 s for confirmation and
  must not hold the gate lock across that wait.

## Docs updated

- `docs/visual-channel.md` — the ack/confirmation contract and the visual
  precedence rule; absorbed `DISPLAY_EXTENSION_ISSUES.md`.
- `README.md`, `apps/frontend/README.md`, `apps/frontend/ARCHITECTURE.md`,
  `apps/frontend/INTEGRATION.md`, `docs/architecture.md`,
  `docs/frontend-command-station-architecture.md`, `docs/hands-free.md` — the
  native runtime replaces the iframe in each. `docs/concurrency-and-test-hazards.md`
  and `docs/display-channel-plan.md` had stale paths corrected.
- `docs/legacy-runtime-removal-handoff.md` — removed; its work is done.
