# Visual Channel Capabilities & Deferred Proposals

`docs/diagram-tool.md` describes the active implementation contracts; this document records implemented capabilities, deferred proposals, and refused patterns.

## Core Principle

The visual stage exists to answer questions that are expensive to ask or answer out loud over audio. Visual payloads must compose with speech rather than compete with it (e.g., "I am on step three of five" is effective spoken prose because the screen presents the full plan).

The stage exists only while there is something real to show. With no artifact,
it collapses and conversation becomes the workspace. The same canonical views
(`auto`, `visual`, `comms`, `system`, `theater`) are controlled by visible
buttons and the agent's `view` tool. Explicit caller focus remains pinned until
the caller returns to Auto. The browser reports the resulting `screen_state`,
so an agent can inspect what is visible rather than assuming its request won.

`docs/frontend-command-station-architecture.md` is the product contract for
this composition behavior.

## Implemented Capabilities

### 1. Multi-Form Mermaid Guidance

The `diagram` tool explicitly prompts project agents to select appropriate diagram forms:

| Form | Primary Use Case |
| --- | --- |
| `flowchart TD` | Architecture, call trees, process flows |
| `sequenceDiagram` | Leg handoffs, caller → operator → agent sequences |
| `stateDiagram-v2` | Leg lifecycle and state machines |
| `timeline` / `gantt` | Execution order and operation schedules |
| `gitGraph` | Branch and commit topology |
| `erDiagram` | Schema and relationship questions |
| `mindmap` | Option trees and decision spaces |

Node styling is restricted to four semantic classes (`:::active`, `:::done`, `:::blocked`, `:::muted`) enforced via server-side validation.

### 2. Structured Live Plan / Checklist (`kind: "plan"`)

Pushed via the `plan` tool to `POST /diagram` with `kind: "plan"`. The client renders progress lists into `<ol class="plan">` with positional updating, active step highlighting (`aria-current="step"`), tabular telemetry details, and dark-mode bloom effects.

### 3. Call-Path Timeline (`kind: "timeline"`)

Pushed via the `timeline` tool to `POST /diagram` with `kind: "timeline"`. The client renders ordered execution steps with optional duration bars, tabular telemetry, and hop counting into `<ol class="plan timeline">`.

### 4. Code Diff View (`kind: "diff"`)

Pushed via the `diff` tool to `POST /diagram` with `kind: "diff"`. Renders unified diffs with line-by-line status styling (`data-op="add|del|ctx"`), line numbers, file paths, and accessible screen-reader annotations.

### 5. Visual History Controls

The stage header includes interactive history controls (back, forward, return to live) allowing callers to step through an 8-frame bounded history ring of visual payloads sent during the call session.

## Deferred Payload Types

The following proposals are explicitly deferred and documented for future iterations:

### 1. Direct Binary Image Payload

- **Purpose**: Transfer PNG/JPEG bytes directly over the socket for display on the stage canvas.
- **Status**: Deferred. Inline HTML images (`<img src="...">`) remain supported within Mermaid nodes where reachable by the browser.

## Explicitly Refused Patterns

- **General Raw HTML / Arbitrary Markup**: Refused. Allowing agents to transmit arbitrary HTML exposes the client page (which holds active WebRTC / WebSocket call state) to cross-site scripting (XSS) via prompt injection from external repositories. All visual features must render from structured data controlled by client code.
- **Adding Environment Variables or Endpoint Overheads**: Refused. All visual kinds multiplex over `POST /diagram` and the existing socket channel to avoid expanding the environment file contract between Switchboard and `homelab`.
