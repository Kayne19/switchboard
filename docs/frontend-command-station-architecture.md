# Frontend Command Station UI Architecture & Specification

This document defines the architectural specification, visual doctrine, tech stack, and migration path for transforming Switchboard's web client into a **high-density, tactical sci-fi command station** inspired by the Evangelion / NERV / MAGI terminal aesthetic.

It is written for future agents and human engineers implementing and extending the frontend interface.

---

## 1. System Vision & Aesthetic Doctrine

Switchboard is a tactical voice front door for a fleet of AI coding agents. The UI serves as the mission control station: establishing audio links, routing calls across distributed nodes, streaming real-time execution telemetry, and rendering 2D/3D wireframe visuals on a dedicated tactical stage.

### Aesthetic Pillars

1. **High-Density Tactical Telemetry**: Monospace precision, mission clocks, coordinate axes, status watermarks, and zero decorative "fluff" without tactical context.
2. **Tri-System / MAGI Routing**: Visualizing the operator, project agents, and host PBX as distinct consensus/routing nodes with active state indicators.
3. **Hardware-Accelerated Phosphor & CRT Shaders**: Scanlines, subtle phosphor persistence trails, glow bloom, and chromatic aberration overlaid on dark-mode military panels.
4. **Audio-Reactive Synchro Waveforms**: Dynamic visualization of incoming and outgoing audio streams (Lissajous curves / synchro rate harmonics).
5. **Acoustic & Haptic Feedback**: Crisp synthesized Web Audio clicks, relay pops, and alert buzzers on state changes.

### Aesthetic & Design Rules (Referencing `nerv-ui`)

Referencing the design patterns from `TheGreatGildo/nerv-ui`:

1. **The Void is the Default**: Elements emerge from true black (`#000000`), not soft gray cards or floating surfaces.
2. **Typography Doctrine (No Helvetica / No Generic Sans)**:
   * **Header / Title Serif**: `Noto Serif Display` (weight 900) mechanically compressed with `transform: scaleX(0.82); letter-spacing: 0.2em; text-transform: uppercase;` (signature Evangelion title aesthetic).
   * **Institutional Japanese / Kanji**: `Shippori Mincho B1` (the open-source equivalent to Evangelion's iconic *Matisse EB*).
   * **Data & Telemetry**: `JetBrains Mono` for clocks, tool outputs, and packet logs.
   * **Emergency Stamps / Warnings**: `Saira Extra Condensed` / `Impact` for emergency banners and PTT hazard warnings.
3. **Functional Color Language**:
   * **NERV Orange (`#FF9830`)**: System labels, classification tags, tool names.
   * **Nominal Green (`#50FF50`)**: Nominal status, audio link healthy, test pass.
   * **Wire Cyan (`#20F0FF`)**: Stage wireframes, synchro curves, spatial models.
   * **Alert Red (`#FF3030`)**: Emergency mode, recording active, errors, discarded turns.
4. **Hard Boundaries**: Stepped blocks, 90-degree sharp corners, 1px technical lines, no bubbly rounded cards.
5. **Emergency Mode**: Global `data-mode="emergency"` attribute shifting green/cyan elements to pulsing warning red.

### Design Discipline & Guardrails (Referencing `evangelion-design`)

To keep the interface severe, functional, and authentic rather than sliding into generic neon cyberpunk or a cluttered theme-park clone (referencing `ckorhonen/claude-skills/evangelion-design`):

1. **Restraint Over Glow**: Most surfaces are matte, flat black (`#000000`), and controlled. Glow is tightly restrained to active signals (PTT trigger, laser lines, alert pulses) rather than smeared everywhere with glassmorphism or fuzzy blurs.
2. **Mechanical Motion**: Animations must behave like machinery under stress—stepped mechanical reveals, counter sweeps, sync ladder steps, and sharp alert pulses rather than floaty spring easings or playful bounces.
3. **Hierarchy Drives Drama**:
   * Critical operational state (PTT trigger, active agent, emergency alerts) is **hero-sized and hot-toned** (amber/red).
   * Secondary telemetry (execution clock, port numbers, VAD probability, tool stdout) is **cool-toned and micro-labeled** (dim green/cyan/steel).
   * Dead space / true black zones are preserved to create focus and visual tension.
4. **Color Independence & Accessibility**: Never use color alone for status. Pair color with explicit state labels (e.g. `[REC]`, `[ONLINE]`, `[HALT]`), geometric notches, or border indicators to preserve WCAG AA legibility and color-blind clarity.
5. **No Generic Cyberpunk Slop**: No purple/magenta neon gradients, no rounded bubbly cards, no faux-futuristic decorative gibberish. Every visual element must map to real Switchboard data (audio stream, PBX route, tool execution, visual stage).

### Color Palette Tokens

```css
:root {
  /* Core Surfaces */
  --station-bg: #08080a;
  --station-surface: #101015;
  --station-surface-alt: #17171f;
  --station-border: #262633;
  --station-border-active: #ff9900;

  /* Tactical Color Accents */
  --nerv-amber: #ff9900;          /* Primary active telemetry, labels, tool logs */
  --nerv-amber-glow: rgba(255, 153, 0, 0.35);
  --magi-red: #ff1e27;            /* Emergency alert, recording active, hangup */
  --magi-red-glow: rgba(255, 30, 39, 0.4);
  --sync-cyan: #00e5ff;           /* Link established, audio stream healthy, VAD active */
  --sync-cyan-glow: rgba(0, 229, 255, 0.35);
  --hazard-yellow: #ffd700;       /* Standby, thinking max, hold */
  
  /* Phosphor & CRT */
  --crt-scanline: rgba(18, 16, 16, 0.3);
  --phosphor-bleed: rgba(255, 153, 0, 0.08);
}
```

---

## 2. Target Tech Stack

```text
+-----------------------------------------------------------------------------------+
|                                FRONTEND ARCHITECTURE                              |
+-----------------------------------------------------------------------------------+
| Core & Framework    | React 19 + TypeScript + Vite 6                              |
| Global State        | Zustand (microsecond slice subscriptions, zero re-render)   |
| Styling & Layout    | Tailwind CSS v4 + Custom SVG/CSS Polygon Clip-Paths         |
| Motion & Polish     | Framer Motion (mechanical reveals, layout transitions)     |
| 3D & Shaders        | Three.js / React Three Fiber (R3F) + GLSL Postprocessing   |
| Audio Engine        | Web Audio API + AudioContext AnalyserNode + AudioWorklets   |
| Wake Word & VAD     | ONNX Runtime Web + openWakeWord (WebAssembly)               |
| Transport           | Native WebSocket Client (binary audio + JSON control frames)|
+-----------------------------------------------------------------------------------+
```

### Why This Stack?

* **React 19 + Vite**: Instant hot module replacement (HMR), clean component hierarchies, and vast visual ecosystem support.
* **Zustand over React Context**: High-frequency streaming packets (telemetry timestamps, audio level meters, tool stdout chunks) must update isolated DOM nodes at 60fps without causing React tree re-render cascades.
* **Tailwind v4**: CSS-first configuration, arbitrary value handling for angled polygon panels (`clip-path: polygon(...)`), and CSS variable integration.
* **React Three Fiber / GLSL Shaders**: Allows rendering 3D wireframe terrain, rotating MAGI node structures, and hardware-accelerated CRT scanlines/bloom.
* **Native Web Audio Synthesis**: Generates zero-latency mechanical interface sounds (PTT clicks, agent transfer chimes) via Web Audio oscillators without loading external audio assets.

---

## 3. UI Component Architecture

```text
+------------------------------------------------------------------------------------+
| StationHeader (Mission Clock // UTC // Link Status // Classification Banner)        |
+------------------------------------------------------------------------------------+
|                                         |                                          |
| TacticalStage (Left Viewport)           | CommandColumn (Right Interaction Deck)   |
|                                         |                                          |
| +-------------------------------------+ | +--------------------------------------+ |
| | 3D Wireframe / Mermaid Canvas       | | | MagiRoutingDeck (Channel Matrix)     | |
| | - CRT Shader Overlay                | | | - Melchior (Op) -> Balthasar (Agent) | |
| | - Coordinate Reticles [X/Y]         | | +--------------------------------------+ |
| | - Stage History Controls (Live/Back)| | | CommDeck (PTT / Hands-Free / Synchro)| |
| +-------------------------------------+ | | - Live Synchro Waveform Canvas       | |
| | Visual Notes & Tool Output          | | | - PTT Tactical Trigger               | |
| +-------------------------------------+ | | - Acoustic Sensor (openWakeWord)     | |
|                                         | +--------------------------------------+ |
|                                         | | TelemetryDeck (Live Tool Execution)  | |
|                                         | | - Sub-routine stdout / T+ clock      | |
|                                         | +--------------------------------------+ |
|                                         | | IntercomLog (Chat Transcript)        | |
|                                         | | - Formatted Markdown + Audio Replay  | |
|                                         | +--------------------------------------+ |
+------------------------------------------------------------------------------------+
```

### Key Component Specifications

#### A. `StationHeader`

* Displays current UTC timestamp and active session runtime clock (`T+00:14:32`).
* System status badge: `LINK: ONLINE // ENCRYPTED // TOKYO-3 HUB`.
* Global error/panic banner during backend socket disconnection or host failures.

#### B. `MagiRoutingDeck`

* Visualizes the PBX routing topology (`operator` vs `project agents`).
* Interactive dropdowns styled as military selector dials:
  * **Route Target**: `[OPERATOR]`, `[DAMOCLES]`, `[HOMELAB]`, etc.
  * **Model Matrix**: `[CLAUDE-3.7-SONNET]`, `[GPT-4O]`, `[DEEPSEEK-R1]`.
  * **Thinking Depth**: `[LEVEL-00: OFF]`, `[LEVEL-01: LOW]`, `[LEVEL-02: MAX]`.
* Dedicated **Emergency Hangup** button returning the circuit to the operator.

#### C. `CommDeck` & `SynchroWaveform`

* **PTT Trigger Button**: Giant high-contrast push-to-talk trigger with states:
  * `STANDBY`: Glowing amber border.
  * `RECORDING`: Flashing red/black hazard stripes (`TRANSMITTING 16kHz PCM`).
  * `PROCESSING`: Rotating technical reticle with elapsed latency timer.
* **Audio Synchro Waveform**: An HTML5 Canvas / WebGL element connected to the microphone's `AnalyserNode`. Visualizes voice activity as intersecting EVA synchro curves.
* **Hands-Free Controller**: Manages local ONNX wake word engine ("Hey Jarvis"), displaying lease timers and real-time VAD speech probability bars.

#### D. `TacticalStage`

* Houses Mermaid charts, HTML visual frames, diffs, and 3D architectural wireframes.
* Wrapped in a hardware-accelerated GLSL CRT scanline / chromatic aberration post-processing layer.
* Technical viewport overlays: crosshair tick marks at corners `[ + ]`, zoom multiplier readout (`ZOOM: 1.25x`), and theater mode expander.

#### E. `TelemetryDeck`

* Displays live in-progress agent tool execution (e.g. `bash: cargo test --locked`).
* Collapsible execution history with microsecond execution timings.

#### F. `IntercomLog`

* Displays turn-by-turn communication logs.
* Styled as tactical dispatch messages: `[COMM LINK // USER]`, `[OPERATOR // MAGI-01]`, `[PROJECT AGENT // DAMOCLES]`.
* Markdown code blocks formatted with terminal syntax highlighting and inline copy actions.

---

## 4. State Management (Zustand Slices)

To prevent UI lag during high-speed audio streaming, state is partitioned into specialized Zustand slices:

```typescript
// 1. Connection & Session Slice
interface SessionSlice {
  connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeRoute: string;
  activeModel: string;
  activeThinking: string;
  routeList: Array<{ id: string; name: string }>;
  modelList: Array<{ id: string; name: string }>;
}

// 2. Comm & Audio Slice (High Frequency)
interface CommSlice {
  audioState: 'idle' | 'listening' | 'recording' | 'processing' | 'playing';
  handsFreeEnabled: boolean;
  vadProbability: number;
  audioLevels: Uint8Array;
  micMuted: boolean;
}

// 3. Telemetry & Activity Slice
interface ActivitySlice {
  isWorking: boolean;
  activeAgent: string;
  elapsedMs: number;
  currentTools: Array<{ id: string; tool: string; detail: string; status: 'running' | 'done' | 'failed' }>;
}

// 4. Tactical Stage Slice
interface StageSlice {
  activeVisual: { id: string; type: 'diagram' | 'html' | 'diff'; content: string; title: string } | null;
  history: Array<VisualSnapshot>;
  historyIndex: number;
  zoom: number;
  theaterMode: boolean;
}

// 5. Transcript Slice
interface TranscriptSlice {
  turns: Array<TranscriptTurn>;
}
```

---

## 5. Audio Pipeline & Worklet Integration

The audio pipeline retains Switchboard's proven zero-latency architecture:

```text
Microphone Input
       │
       ▼
AudioContext (16kHz PCM)
       ├──► AudioWorklet (vad-worklet.ts) ──► Speech Boundary Detection
       ├──► AnalyserNode ─────────────────► SynchroWaveform Canvas (60fps)
       ├──► ONNX Worker (wake_word.ts) ───► "Hey Jarvis" Detection
       └──► WebSocket Output ─────────────► Switchboard Backend / STT
```

* **Zero Memory Allocation in Worklets**: Audio chunks continue using shared ring buffers and Float32Array transfers.
* **Audio Synthesis (SFX)**: Web Audio API `OscillatorNode` and `GainNode` synthesize authentic mechanical clicks on PTT press (`frequency: 800Hz -> 1200Hz`, `decay: 40ms`).

---

## 7. Spatial Viewport Mapping & Voice Navigation Protocol

To enable hands-free workout and distant-screen interaction, the agent possesses programmatic spatial control over the user's display. Instead of forcing all widgets to fit simultaneously on smaller screens, the agent dynamically reconfigures the viewport based on the caller's spoken intent.

### Visual State & View Protocol (`type: "view"`)

The backend and project agents can transmit a lightweight spatial control message:

```json
{
  "type": "view",
  "target": "stage" | "comms" | "magi" | "overview" | "theater",
  "reason": "Displaying transformer architecture graph"
}
```

### Supported View Targets

| Spoken Intent / Trigger | `target` | Client State & Behavior |
|---|---|---|
| *"Pull up the architecture / loss graph / diff"* | `"stage"` | Collapses Bay 1 & 3, expanding Bay 2 (Stage) to dominant screen width. |
| *"Show me the full transcript / email summary"* | `"comms"` | Maximizes Bay 3 (Comms) with large 1.15rem high-contrast typography readable from 8+ feet away. |
| *"Show me the fleet routing / MAGI consensus"* | `"magi"` | Maximizes Bay 1 (MAGI) to display node health, route switches, and model dials. |
| *"Give the diagram the whole screen"* | `"theater"` | Enters full-screen Theater mode (100% viewport, hiding all side chrome). |
| *"Reset view / show everything / overview"* | `"overview"` | Restores the balanced 3-bay command matrix. |

### Integration with Existing Visual Payloads

When an agent invokes the `diagram`, `diff`, or `plan` tool, the visual stage automatically brings Bay 02 into active focus. This ensures that callers never have to physically touch the iPad or mouse to view what was just discussed.


To ensure continuous development without breaking call control or test suites:

### Phase 1: Style & Component Foundation

1. Configure Vite + React 19 build pipeline alongside existing static assets.
2. Port CSS custom properties and establish Tailwind v4 tactical design system.
3. Build standalone HUD components (`StationHeader`, `MagiRoutingDeck`, `IntercomLog`).

### Phase 2: Audio & State Porting

1. Connect Zustand store to Switchboard WebSocket protocol handlers (`protocol.ts`).
2. Integrate Web Audio `vad-worklet` and `openwakeword` ONNX models into React hooks.
3. Implement `SynchroWaveform` canvas component.

### Phase 3: Tactical Stage & Shaders

1. Re-implement `stage.ts` diagram zoom/pan/history inside React.
2. Add GLSL CRT scanline overlay and Three.js tactical wireframe renderer for visual stages.

### Phase 4: Verification & Gate Parity

1. Verify all automated frontend tests in `apps/frontend/tests/`.
2. Confirm build output generates into `static/` to satisfy repository CI and deployment contracts.
3. Ensure keyboard shortcuts (`T` for Theater, `Space`/`Escape` for PTT/Discard) work seamlessly.
