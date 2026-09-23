# Plan: make the frontend the agent’s display channel

Read first: `docs/visual-channel.md` (principles and refused patterns),
`apps/frontend/PROTOCOL.md` (the six-operation semantic protocol),
`apps/frontend/ARCHITECTURE.md` (data flow and the extension strategy), and
`diagram-tool.md` (the display channel contract).

## What this is

The V17 frontend is already a complete, general-purpose display layer:

- A six-operation semantic protocol: `show`, `hide`, `say`, `focus`,
  `listen`, `clear`.
- A primitive for every content type: `chart`, `metric`, `progress`,
  `diagram`, `code`, `document`, `message`, `note`
  (`apps/frontend/src/primitives/`: Chart, Metrics, Progress, Diagram,
  CodeViewport, DocumentViewport, RichText, AnnotationCard, ...).
- A scene classifier (`app/sceneModel.ts`) that composes whatever objects
  exist, with roles (`primary`/`compare`/`secondary`/`ambient`) and stable IDs
  that give layout and motion continuity.
- A validation boundary (`controller/validation.ts`) that rejects layout,
  oversized, and unknown payloads, and a live `window.SwitchboardController.
  dispatch` (already driven by the dev `ControllerPanel`).

The agent, by contrast, reaches only a sliver of it. Its visual tools are a
fixed menu — `diagram`, `plan`, `timeline`, `diff`, `view` — and of the eight
content types it can actually produce only two or three:

| content type | renderer can draw | agent can reach today |
| --- | --- | --- |
| diagram | yes | yes (Mermaid, or forced-linear plan/timeline) |
| code | yes | yes (via `diff`) |
| progress | yes | only as a side effect of plan/timeline |
| chart | yes | **no** |
| metric | yes | **no** |
| document | yes | **no** |
| note | yes | **no** |
| message | yes | runtime-owned (the live transcript) |

So the layer exists and the agent is locked to a pre-baked menu. The idea is
to **expose the protocol as the agent’s display interface**, so the agent
displays information however it chooses: any content type, any role and
composition, the display operations, and stable IDs for continuity. The
diagram tool is the first and most visible piece of this, not the whole thing.

The boundary that makes "however it chooses" safe is the layer’s identity,
not a constraint to fight: the agent chooses *what* to show and *which
semantic form and composition*; the renderer owns *where, how many pixels,
theme, and motion*. Raw HTML/markup is refused; coordinates and CSS never
cross the boundary. (PROTOCOL.md: "It never says where or how many pixels.")

## The three channels to the caller (kept distinct)

- `speak` (`POST /speak`): audio.
- `display` (`POST /display`, the general channel): on-screen content
  objects and the display operations.
- `view` (`POST /view`): screen mode (`auto`/`visual`/`comms`/`system`/
  `theater`) with caller-pin precedence and `screen_state` truth.

`display` is objects and their state; `view` is which composition dominates;
`speak` is the voice. They interlock (e.g. `focus` on the primary object ~
`view theater`) but are separate tools with separate contracts. Routing tools
(`transfer_to_project`, `return_to_operator`, `set_model`) are unchanged.

## The channel (agent-facing design)

One tool, `display`, whose parameters *are* a protocol action:

```
{ op: "show"|"hide"|"say"|"focus"|"clear",
  id?: string,            // stable object id; reuse to update in place
  type?: "chart"|"metric"|"progress"|"diagram"|"document"|"code"|"note",
  role?: "primary"|"compare"|"secondary"|"ambient",
  data?: { ...typed by type... },
  text?: string,          // for say
  target?: string,        // for say: anchor to an object
  at?: { x?, series? } }  // for say: anchor to a chart point
```

- The agent picks `op` + `type` + `role` + `data` however it chooses, within
  the approved vocabulary. It builds a scene by calling `display` several
  times with different IDs and roles; it updates an object by re-`show`ing the
  same ID (the renderer preserves continuity); it retires objects with `hide`
  and resets with `clear`.
- One action per call. A "scene" is just N calls; no new operation is needed
  (PROTOCOL.md: a new op requires an interaction the six cannot express).
- `message` is **runtime-owned** and is not an agent `display` type — the live
  call transcript cannot be forged. The agent’s on-screen asides go to
  `note`; its spoken words go to `speak`. So the agent’s usable types are
  the seven: chart, metric, progress, diagram, document, code, note.
- `listen` (mic state) stays with the voice runtime, not `display`.
- Runtime objects keep a reserved ID namespace (the conversation, the presence)
  so agent-chosen IDs cannot collide with them.

## The wire

Dedicated endpoint `POST /display` with `SWITCHBOARD_DISPLAY_URL`, per-generation token authentication, and the browser's existing WebSocket. The payload on `POST /display` is `{ token, action }`; the socket carries a `display` event.

Roles on the pipe:

- **Backend = validating relay.** It authenticates (session token), validates
  the action against the protocol boundary (the Rust port of
  `validation.ts`: known op/type, valid ID, no layout fields, size caps,
  finite chart/progress numbers), stamps it for the delivery system, holds it
  in `last_display` for later page opens, broadcasts it, and replays on
  connect. It does **not** interpret content.
- **Frontend = faithful renderer.** A new `handleServer` case `display`
  validates (same boundary) and calls `dispatch(action)`. The bespoke per-kind
  translation that lives there today — `linearDiagram` and the big switch in
  `apps/frontend/src/integration/runtime.tsx` — is deleted; that intelligence
  moves to the agent, which now sends semantics directly.

The renderer’s hard work is done. This is mostly a channel change: the
agent speaks the protocol, the backend relays it, the frontend dispatches it.

## Deployment (one atomic redeploy, no shims)

The backend, the browser build (`static/`), and the extension all move in the
**same redeploy operation**: the backend and the browser build ship in one
container, and the extension is staged to the project hosts in that same
operation. So old and new never coexist anywhere — there is no "new backend,
old browser" or "old extension, new backend" combination to bridge.

Consequence: **no compatibility shims at all.** No dual-emit, no dual-protocol
intake, no version matrix, no temporary branch. The new channel, the deletion
of the old `diagram`/`plan`/`timeline`/`diff` tools, and the deletion of the
backend’s per-kind branch all land in **one commit**, and a redeploy of
that commit is the entire rollout. Rollback is a revert to the previous
commit, which brings back the old channel as a unit.

(If the extension rollout is ever decoupled from the container redeploy, this
section reopens: that is the only change that would reintroduce a skew window,
and the fix would be to keep the per-kind intake branch for the window. Not
the plan as built.)

## What moves where (concrete)

- `extensions/agent-switchboard.ts`: add the general `display` tool; delete the
  `diagram`/`plan`/`timeline`/`diff` tools in the same commit. `speak`,
  `view`, and the routing tools are unchanged.
- `apps/backend/src/api.rs`: `POST /display` accepts `{ token, action }`; add
  protocol validation (a small module, the Rust port of `validation.ts`);
  broadcast a `display` event; rename `last_diagram` to `last_display` and keep
  hold/replay; delete the per-kind intake branch in the same commit.
- `apps/frontend/src/integration/runtime.tsx`: add `case "display"` ->
  validate + `dispatch`; delete the per-kind switch and `linearDiagram`; keep
  the session cases (`epoch`, `history`, `transcript`, `spoken`, `view`,
  `error`) and runtime ownership of the `message`/conversation objects.
- `apps/frontend/src/controller/validation.ts`: becomes the single gate, used
  by both the `window.SwitchboardController` boundary and the `display` relay.
- Primitives: all eight exist; make small refinements only (diagram edge
  labels + the active-edge rule; align the Mermaid theme to design tokens).
  Add a new primitive only if a type is found genuinely lacking, following
  `ARCHITECTURE.md`’s seven-step extension strategy.

## Phases

### Phase 0 - baseline and inventory
1. Green baseline: the full `AGENTS.md` gate set plus a Playwright visual run,
   so regressions are attributable.
2. The gap table above, proven against the code (which types the agent can
   reach vs. which the renderer can draw).
3. Snapshot before/after renders at the approved geometries (portrait,
   standard landscape, very wide landscape).
4. Confirm the validation rules and the reserved-ID namespace.
5. Confirm the extension is staged in the same operation as the container
   redeploy (the assumption the no-shim design rests on).

### Phase 1 - the general channel, end to end
One change, atomic across backend, browser, and extension:
1. Backend: action intake, protocol validation, `display` broadcast,
   `last_display` hold/replay; per-kind branch deleted.
2. Extension: the `display` tool; the four old tools deleted.
3. Frontend: the `display` relay; per-kind translation deleted; primitive
   refinements.
4. Tests: Rust protocol-validation unit tests (pattern: the diagram tests in
   `apps/backend/tests/test_api.rs`); `test_extensions.mjs` for `display`; V17
   unit tests (validation, reducer, scene model, the refined primitives); a
   Playwright visual of a *composed* scene — e.g. a `diagram` (primary) with a
   `note` (secondary) and a `metric` (ambient) — at the approved geometries.
5. Rebuild `static/` in the same commit (committed build; the usual CI breaker).

Verify against the live backend in one pass: the agent composes a multi-object
scene, updates an object in place, focuses it, hides it, and `screen_state`
stays truthful. Rollback is a revert.

### Phase 2 - parity
Prove the agent reaches all seven usable types through `display` via live
calls (chart, metric, progress, diagram, document, code, note), each rendered
correctly in the composed scene.

### Phase 3 - docs
Rewrite `diagram-tool.md` into the channel contract and update
`docs/visual-channel.md` (the implemented capabilities now include the general
channel; Mermaid becomes one content type, not the interface). The deploy is
the homelab pinned-tag cutover from `docs/extraction-plan.md` — one atomic
switch of the container from this tree.

## Decisions made here (veto any)
- One general `display` tool. Fallback if the model flails on the union
  schema: split into 1:1 tools per operation.
- `POST /display` is the dedicated display endpoint (with `SWITCHBOARD_DISPLAY_URL`); the
  payload is authenticated and strictly validated.
- `message` is runtime-owned; agent asides use `note`; `speak`/`view`/`listen`
  stay separate channels.
- The agent owns object IDs (reserved namespace for runtime objects).
- One action per call; a scene is N calls.
- One atomic redeploy (backend + browser + extension move together): no shims,
  no version matrix, no temporary branch. The new channel and the deletion of
  the old tools and per-kind branch land in a single commit.

## Non-goals
- Clean cutover to dedicated display endpoint and environment variable; no compatibility aliases.
- No coordinates, CSS, or raw HTML/markup from the agent; the transcript is
  not forgeable.
- No turn dispatch, epoch, page-rescue, or routing changes (read
  `docs/concurrency-and-test-hazards.md` first if anything ever touches that
  neighbourhood).
- No new renderer in the legacy tree (it is on a deletion schedule).
- No generic component library; no device-specific layout branches.
- The voice runtime and hidden iframe belong to
  `docs/legacy-iframe-rewrite-plan.md`; this plan leaves them alone.
