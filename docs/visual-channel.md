# Visual Channel Capabilities & Deferred Proposals

`docs/diagram-tool.md` describes the active implementation contracts; this document records implemented capabilities, deferred proposals, and refused patterns.

## Core Principle

The visual stage exists to answer questions that are expensive to ask or answer out loud over audio. Visual payloads must compose with speech rather than compete with it (e.g., "I am on step three of five" is effective spoken prose because the screen presents the full plan).

## Implemented Capabilities

### 1. Multi-Form Mermaid Guidance

The `diagram` tool explicitly prompts project agents to select appropriate diagram forms:

| Form | Primary Use Case |
|---|---|
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

## Deferred Payload Types

The following proposals are explicitly deferred and documented for future iterations:

### 1. Diff View

- **Purpose**: Render unified git diffs for code changes proposed or made by coding agents.
- **Rationale**: Diff details are nearly impossible to read aloud cleanly.
- **Status**: Deferred. Future implementations can introduce a structured `kind: "diff"` with hand-written line rendering in `static/index.html`.

### 2. Call-Path Timeline

- **Purpose**: Show historical leg transitions, handoffs, and durations over the lifetime of a call.
- **Status**: Deferred.

### 3. Diagram & Visual History Strip

- **Purpose**: Provide UI controls to step back through the last N visuals sent during a call.
- **Status**: Deferred. The server currently retains only `last_diagram` for reconnection replay.

### 4. Direct Binary Image Payload

- **Purpose**: Transfer PNG/JPEG bytes directly over the socket for display on the stage canvas.
- **Status**: Deferred. Inline HTML images (`<img src="...">`) remain supported within Mermaid nodes where reachable by the browser.

## Explicitly Refused Patterns

- **General Raw HTML / Arbitrary Markup**: Refused. Allowing agents to transmit arbitrary HTML exposes the client page (which holds active WebRTC / WebSocket call state) to cross-site scripting (XSS) via prompt injection from external repositories. All visual features must render from structured data controlled by client code.
- **Adding Environment Variables or Endpoint Overheads**: Refused. All visual kinds multiplex over `POST /diagram` and the existing socket channel to avoid expanding the environment file contract between Switchboard and `homelab`.
