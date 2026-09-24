# Switchboard Design System

## Status

The rules marked **LOCKED** are approved product constraints. A change to one is a design change, not routine refactoring. Update the canonical fixtures and visual references only after explicit approval.

## Core model

Switchboard is not a dashboard. It is a black visual field inhabited by one persistent intelligence. Damocles summons useful content into that field, changes its emphasis, and dismisses it when it is no longer relevant.

The model controls semantic intent. The frontend controls composition, geometry, readability, motion, and responsive behavior.

## Locked invariants

### Identity

- **LOCKED:** The exact Damocles glyph geometry lives in `DamoclesGlyph.tsx`. Do not redraw, approximate, simplify, stretch, or replace it with an icon asset.
- **LOCKED:** The diagonal form is the sword hilt. The two lower vertical forms are the blade.
- **LOCKED:** Damocles remains visibly present whenever the composition has room for it.
- **LOCKED:** The glyph gently floats during idle and active content states.
- **LOCKED:** Listening accelerates the floating motion smoothly. It must not jump between animation states.
- **LOCKED:** The listening waveform is anchored to the presence component, not independently positioned against page content.
- **LOCKED:** The rare glint is restricted to the lower blade geometry.

### Composition

- **LOCKED:** The base canvas is true black.
- **LOCKED:** The interface must not drift into a dashboard, card grid, tiling window manager, or enterprise panel layout.
- **LOCKED:** Content is allowed to dominate the display. Damocles can recede to a rail or compact presence.
- **LOCKED:** Portrait is a genuine recomposition, not a scaled desktop layout.
- **LOCKED:** Responsive decisions derive from available geometry and aspect ratio. Do not add device names or device-specific pixel breakpoints.
- **LOCKED:** New scenes compose shared primitives before inventing bespoke page markup.
- **LOCKED:** Metadata at the lower edges shares a consistent baseline within a composition family.

### Visual language

- **LOCKED:** The initial NERV-inspired palette is the baseline: red identity, orange instrumentation, green and cyan data accents, paper-white text, and a black field.
- **LOCKED:** Technical labels must carry real meaning. Do not fabricate sci-fi telemetry.
- **LOCKED:** Frames use sharp rectangular geometry with selective clipped or stepped corners. Do not replace them with rounded cards.
- **LOCKED:** Evangelion influence belongs primarily in hierarchy, spacing, geometry, annotation, framing, and motion. It must not damage chart, document, code, or diagram readability.
- **LOCKED:** Large alert typography is reserved for states that actually justify it.

### Interaction

- **LOCKED:** Focus expands the existing semantic object. It is not a separate destination page.
- **LOCKED:** Scrollable content stays inside its shared irregular viewport primitive and must never cross decorative frame geometry.
- **LOCKED:** A scroll region only scrolls when its content exceeds its bounds.
- **LOCKED:** Listening does not destroy or replace the current content scene.
- **LOCKED:** The historical transcript is hidden by default in hands-free mode and can be explicitly expanded.
- **LOCKED:** Conventional controls remain visually subordinate and appear only where interaction requires them.

### Model contract

- **LOCKED:** The model never specifies pixel coordinates, element widths, device classes, or CSS.
- **LOCKED:** The protocol remains semantic and small: `show`, `hide`, `say`, `focus`, `listen`, `clear`.
- **LOCKED:** `show` is an upsert. Do not introduce a separate update operation without a demonstrated need.
- **LOCKED:** Comparison is another object with `role: "compare"`, not a dedicated protocol operation.
- **LOCKED:** Annotation is `say` targeted at an object, not a dedicated protocol operation.

## Primitive ownership

| Primitive | Owns |
|---|---|
| `DamoclesPresence` | identity, float, listening, voice indicator, caption |
| `TechFrame` | approved frame paths and frame construction motion |
| `ChartPrimitive` | chart geometry, axes, traces, semantic series colors |
| `DiagramPrimitive` | node layout, edge routing, portrait and landscape topology |
| `CodeViewport` | syntax presentation, safe scrolling, irregular clipping |
| `DocumentViewport` | readable document layout and bounded scrolling |
| `MetricsPrimitive` | metric alignment and semantic values |
| `AnnotationCard` | targeted explanation and rich text semantics |
| `ChartNotes` + `notePlacement` | every note on a chart, laid over it clear of the others, their points and the traces; the angular leader from card to point |
| `FocusableSurface` | accessible activation without invalid button-wrapped scroll regions |
| `FocusLayer` | shared-object expansion and return behavior |
| Controller reducer | six-operation state semantics |

A page-level patch that duplicates one of these responsibilities is usually incorrect.

## Motion grammar

| Event | Meaning |
|---|---|
| New object | Resolves out of the void, then becomes sharp |
| Updated object | Changes in place without being recreated |
| Removed object | Content de-resolves, then its frame withdraws |
| Recomposition | Existing objects move and resize continuously |
| Focus | The same object expands through a shared layout identity |
| Annotation | Explanation resolves near its semantic target |
| Clear | Content recedes until only Damocles remains |

Ordinary structural motion should remain quick, generally about 200 to 500 ms. Idle motion and rare flourishes may be slower. Respect `prefers-reduced-motion`.

## Change policy

Before modifying a locked primitive:

1. Reproduce the issue using a canonical fixture.
2. Confirm that the issue belongs to the primitive rather than one scene.
3. Fix the primitive once.
4. Run unit, design-lock, and visual tests.
5. Review all canonical aspect ratios.
6. Update golden screenshots only with explicit design approval.
