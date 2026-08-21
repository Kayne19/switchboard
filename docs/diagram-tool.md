# The `diagram` tool & Visual Stage

A project agent can push a diagram or a structured plan to the caller's page mid-turn, the same way it pushes speech. The caller sees it render while the agent is still working.

## Why it is shaped like `speak`

`speak` already solved this problem. A tool that has to reach the browser *during* a turn cannot wait for the RPC stream to settle, so it does not use the RPC stream: it POSTs to this service and the service broadcasts on the socket the browser is already holding. `diagram` and `plan` reuse that pattern with different payloads over the same endpoint, preserving the environment file contract without introducing new environment variables.

| piece | `speak` | `diagram` / `plan` |
| --- | --- | --- |
| env var handed to the agent | `SWITCHBOARD_SPEAK_URL` | `SWITCHBOARD_DIAGRAM_URL` |
| endpoint | `POST /speak` | `POST /diagram` |
| broadcast | `{"type":"spoken"}` + mp3 bytes | `{"type":"diagram", ...}` |

The tool is deliberately **not** a `SIGNAL_TOOL` in `piclient.py`. Signals exist so `pbx.py` can swing the route or suppress a re-synthesis; a visual payload changes neither. Nothing in the routing layer needs to know it happened.

## Endpoint & Payload Contract

The `POST /diagram` endpoint accepts four visual payload kinds (`mermaid`, `plan`, `timeline`, `diff`):

### 1. Mermaid diagram payload

```json
{ "kind": "mermaid", "source": "flowchart TD\n  A --> B", "title": "call path", "notes": "optional" }
```

`kind` defaults to `"mermaid"` if omitted or blank. For backward compatibility with legacy WebSocket clients, a Mermaid diagram broadcasts an exact 4-key JSON frame (`{"type":"diagram", "source":..., "title":..., "notes":...}`).

### 2. Structured plan payload

```json
{
  "kind": "plan",
  "source": "",
  "items": [
    { "label": "Parse configuration", "state": "done", "detail": "config.toml" },
    { "label": "Compile TypeScript assets", "state": "active", "detail": "web/stage.ts" },
    { "label": "Run test suite", "state": "todo" }
  ],
  "title": "Build pipeline",
  "notes": "optional"
}
```

### 3. Timeline payload

```json
{
  "kind": "timeline",
  "source": "",
  "items": [
    { "label": "Caller connected", "state": "done", "ms": 120 },
    { "label": "Routed to agent", "state": "active", "ms": 450, "detail": "damocles" }
  ],
  "title": "Call Timeline",
  "notes": "optional"
}
```

### 4. Diff payload

```json
{
  "kind": "diff",
  "source": "@@ -1,2 +1,2 @@\n-old line\n+new line",
  "title": "Code changes",
  "notes": "optional"
}
```

The agent extension passes `source: ""` on plan and timeline payloads to maintain compatibility with legacy backends expecting a string `source` field.

### Server Validation & Caps

- **Body cap**: `64 KB` maximum (`DefaultBodyLimit::max(64 * 1024)`).
- **Title / Notes**: `title` ≤ 200 bytes, `notes` ≤ 300 bytes.
- **Mermaid source**: non-empty, ≤ 20,000 bytes.
- **Plan / Timeline items**: 1 to 40 items per payload.
- **Item fields**: `label` 1..=200 bytes, `detail` ≤ 300 bytes, `state` in `{"done", "active", "todo", "blocked"}` (defaults to `"todo"` if omitted or blank). `ms` ≤ 86,400,000 (timeline only).
- **Diff source**: non-empty, ≤ 20,000 bytes, ≤ 600 lines, must contain at least one `@@` hunk header.
- **Active constraint**: at most 1 item may be `active` at a time.
- Rejections return HTTP 400 with `{"delivered": false, "detail": "<limit hit>"}` which is surfaced directly to the agent.

## Trust Exposure & Boundary

- **Mermaid exposure**: `securityLevel: "antiscript"` is set in Mermaid configuration to prevent script execution while supporting rich node labels. Because the agent reads repositories it did not write, Mermaid diagrams pass through sanitized rendering.
- **Structured safety**: Structured kinds (`plan`, `timeline`, `diff`) do **not** inherit raw HTML rendering risks. Items and code lines are written to the DOM exclusively via `textContent` (never `innerHTML`). Server caps bound storage and replay sizes in `last_diagram`.
- **Palette enforcement**: The server validates Mermaid source lines and rejects custom `classDef`, `style`, `linkStyle`, `%%{init}`, `class` statements, unknown `:::class` names, or multiple `:::active` declarations. The page strictly owns the color palette.

## Visual System & Style Grammar

The stage uses Switchboard's restrained NERV instrument language: black
surfaces, hard boundaries, compressed headings, monospace data, and motion only
when state changes. Styling never invents telemetry.

### Design Tokens

- `--void`, `--panel`, `--panel-hi`, `--line`, `--text`, `--steel`: surfaces and text
- `--amber`: active controls and institutional labels
- `--cyan`: information flow and the active causal path
- `--ok`: completed work
- `--hold`: blocked or held state
- `--danger`: recording, errors, and destructive actions

### Mermaid Semantic Classes

Agents style nodes using four semantic classes mapped to page tokens:

- `:::active`: Active causal path (2px cyan stroke)
- `:::done`: Completed node (1px green stroke)
- `:::blocked`: Blocked node (1px amber stroke)
- `:::muted`: De-emphasized node (1px muted stroke)

### Plan Visual Grammar

Plan rows render into `<ol class="plan">` inside `#stageCanvas`:

- **Left rail**: 3px vertical rail (`::before`), colored by state (`--ok`, `--energy`, `--hold`, `--line`).
- **Ordinal**: `.idx` (`ui-monospace`, `0.72rem`, `tabular-nums`) displaying step numbers (`01`, `02`).
- **Glyph**: State glyph (`✓` done, `▸` active, `·` todo, `!` blocked).
- **Label**: `system-ui` interface type.
- **Detail**: Monospace (`ui-monospace`, `0.78rem`) for paths, symbols, counts, and durations.
- **Active row**: Receives `--rail-active-wash` background. In dark mode, the rail features a single localized bloom `drop-shadow(0 0 6px var(--bloom))`.

## Client Architecture & Stage Shell

- `apps/frontend/src/stage.ts` manages stage state, element references, body classes (`has-diagram`, `stage-structured`, `stage-stale`), history, and renderer registration.
- **Adaptive composition**: Without a visual, the stage collapses completely. New visual content appears in the shared workspace and may receive automatic focus unless the caller pinned another view.
- **Pending payload queue**: Visual messages arriving before a renderer registers (e.g. while Mermaid CDN imports load) are queued and automatically flushed upon renderer registration. If loading fails, the source is shown as a readable fallback rather than a blank stage.
- **Stale visual provenance**: Route changes invoke `markStale()`, adding the `stage-stale` body class and a "From the previous leg" provenance caption instead of presenting old content as current.

## Deployment & Homelab Dependency

`extensions/agent-switchboard.ts` is the authoritative reference copy in this repository. However, production project hosts receive extensions rendered from Ansible templates in the homelab repository (`switchboard_projects`).

- Extension updates land on project hosts (`damocles`) only through a homelab PR cutover.
- Structured tools send `source: ""` so legacy backends can deserialize the shared request without an HTTP 422.
- If a legacy endpoint returns HTTP 422 or 404, the extension refusal helper names the unavailable screen and provides an action-specific fallback:
  - diagram: `this deployment has no diagram screen; describe the steps in words`
  - plan: `this deployment has no plan screen; describe the steps in words`
  - timeline: `this deployment has no timeline screen; describe the timeline in words`
  - diff: `this deployment has no diff screen; describe the changes in words`
