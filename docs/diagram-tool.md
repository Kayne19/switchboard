# The `display` channel & Visual Stage

A project agent pushes anything it wants the caller to *see* — a diagram, a chart, a metric, a progress list, a document, code, or a plain note — to the caller's page mid-turn, the same way it pushes speech. The caller sees it render while the agent is still working. **The agent chooses what to show and how it is composed; the page owns the pixels.** `docs/visual-channel.md` is the product/capability companion to this wire contract.

## Why it is shaped like `speak`

`speak` already solved this problem. A tool that must reach the browser *during* a turn cannot wait for the RPC stream to settle, so it POSTs to this service and the service broadcasts on the socket the browser is already holding. `display` reuses that pattern, preserving the environment-file contract without a new endpoint or a new variable.

| piece | `speak` | `display` |
| --- | --- | --- |
| env var handed to the agent | `SWITCHBOARD_SPEAK_URL` | `SWITCHBOARD_DIAGRAM_URL` (**unchanged**) |
| endpoint | `POST /speak` | `POST /diagram` (**unchanged** — name kept for compatibility) |
| broadcast | `{"type":"spoken"}` + mp3 bytes | `{"type":"display","action":{...}}` |

`display` **replaces** the old per-kind `diagram`/`plan`/`timeline`/`diff` tools with one general tool. The endpoint path and the env var are unchanged; only the payload changed — from a per-kind body to a protocol action. The tool is still deliberately **not** a `SIGNAL_TOOL` in `piclient.py` (a visual changes neither routing nor re-synthesis).

## The action protocol

Every call is a protocol action:

```ts
{ op, id, type, role, data, text, target, at }
```

- **ops** (one per call): `show | focus | hide | clear | say`. There is **no** `listen` on this channel.
- **content types** (for `show`): `chart | metric | progress | diagram | document | code | note`. `message` is a runtime-owned transcript, **not** a display type.
- **roles** (composition slot): `primary | compare | secondary | ambient`.
- **`id`**: agent-owned and stable across updates (re-send the same `id` to replace the object). The runtime reserves its own ID namespace for conversation/presence.
- **`target`**: the object id for `focus`/`hide`/`say` (`clear` takes none).
- **`at`**: client clock; `null` means "now".

### show (create or update)
```json
{ "op":"show", "id":"arch", "type":"diagram", "role":"primary",
  "data":{ "kind":"mermaid", "source":"flowchart TD\n  A --> B" } }
```
### focus / hide / clear / say
```json
{ "op":"focus", "target":"arch" }
{ "op":"hide",  "target":"arch" }
{ "op":"clear" }
{ "op":"say",   "target":"arch", "text":"watch the red edge" }
```

## Content types

| type | `data` shape (excess fields rejected) | what the page renders |
| --- | --- | --- |
| `chart` | `{ kind: "bar"\|"line"\|"pie"\|"spark", series: [{label, values[], color?}], labels?, unit? }` | SVG chart |
| `metric` | `{ label, value, unit?, trend? }` | numeric gauge |
| `progress` | `{ items: [{label, state, note?}], note? }` | plan/checklist rail |
| `diagram` | `{ kind: "mermaid", source }` | Mermaid graph (semantic classes only) |
| `document` | `{ blocks: [{ heading?, paragraph?, bullets?, code? }] }` | document blocks |
| `code` | `{ language?, lines: [{ text, op?: "add"\|"del"\|"ctx" }] }` | diff/code view |
| `note` | `{ text }` | plain aside (the agent's own words) |

A composition is a set of `show`s with distinct `id`s and roles — e.g. a `diagram` as `primary`, a `note` as `secondary`, a `metric` as `ambient`. The page lays the roles out; the agent never sends coordinates.

## Validation & caps (one source, mirrored)

The **canonical** validation is `apps/frontend/src/controller/validation.ts`. The backend holds a Rust mirror, `apps/backend/src/visual_protocol.rs`, so a malformed action is rejected at the wire (HTTP 400, before any socket fan-out) and the frontend re-validates on receipt and replay. The mirrors are asserted equivalent by tests in both languages.

- `id` ≤ 128 UTF-16 code units; `text` ≤ 50,000.
- `chart`/`metric`/`progress` enforce exact data shapes; chart values and progress states must be finite / in the allowed set.
- **256 KB** serialized action cap (the transport remains 64 KB per request).
- **Recursive layout-field rejection**: `layout`, `style`, `css`, `className`, `width`, `height`, `left`, `right`, `top`, `bottom` anywhere in an action are rejected — the page owns geometry.
- **Reserved IDs**: the runtime's conversation/presence namespace cannot be displayed or addressed.
- Rejections return `{"delivered":false,"detail":"<reason>"}` and are **not** broadcast.

## Endpoint

`POST /diagram` (64 KB body cap, `SWITCHBOARD_TOKEN` bearer auth). Body = the action object plus `token`. Success returns `{"delivered":true,"action":{...}}` and broadcasts `{"type":"display","action":{...}}` (token stripped).

## Replay & state

- **`last_display`**: the last successful action. New browser sockets replay it (re-validated before applying).
- **`screen_state`**: `has_visual`/`visual_kind` track the visible object — `show` sets them, `clear` clears them; `say`/`focus`/`hide` leave them as-is. The agent inspects `screen_state` via `view` rather than assuming its request landed.

## Trust & safety

- **Raw HTML / arbitrary markup is refused** — every type renders from structured data via `textContent` (never `innerHTML`); Mermaid runs with `securityLevel: "antiscript"`.
- **No new endpoint, no new env var** — the whole channel multiplexes over `POST /diagram` and the existing socket, so the Switchboard↔homelab env contract is unchanged.

## Deployment

Backend, browser build, and extension move in a **single container** and redeploy together (no dual-emit shims, no version matrix). The extension is the only cross-boundary artifact (it ships via a homelab PR). Rollback is a plain revert of the commit.
