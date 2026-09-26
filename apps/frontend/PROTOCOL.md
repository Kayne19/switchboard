# Damocles Display Protocol

## Purpose

The protocol says what Damocles wants displayed. It never says where or how many pixels to use.

## Operations

### `show`

Create or update an object. Reusing an ID updates the existing object in place.

```json
{
  "op": "show",
  "id": "gpu",
  "type": "metric",
  "data": { "label": "GPU", "value": "94%" }
}
```

Optional `role` values are `primary`, `compare`, `secondary`, and `ambient`.

### `hide`

Remove one object.

```json
{ "op": "hide", "id": "gpu" }
```

### `say`

Display a current explanation, optionally attached to an object or a semantic point.

```json
{
  "op": "say",
  "target": "loss",
  "at": { "x": 32, "series": "VAL LOSS" },
  "text": "Validation begins diverging here."
}
```

### `focus`

Expand an existing object. Use `null` or omit `id` to leave focus.

```json
{ "op": "focus", "id": "loss" }
```

### `listen`

Set the listening state without replacing the current scene. `listen` belongs
to the browser's own voice runtime and page controls: the agent's `display`
channel carries the other five and rejects it (`docs/display-tool.md`).

```json
{ "op": "listen", "on": true }
```

### `clear`

Remove content and return to the Damocles presence.

```json
{ "op": "clear" }
```


## Value normalization

`progress.value` is a percentage in 0–100. Out-of-range values clamp to [0, 100],
and values are rounded to two decimal places. A value of `1` means 1%, not
complete. The fill and `aria-valuenow` derive directly from this percentage.
The display tool asks models for `value (percent, 0-100)`. Non-finite numbers
are rejected.

## Runtime boundary

`src/controller/validation.ts` validates untrusted browser or WebSocket payloads before they reach the reducer. Internal React code remains strongly typed, while the external `window.SwitchboardController` boundary rejects unknown operations, malformed IDs, oversized payloads, and model-controlled layout fields.

## Deliberate omissions

There is no `update`, `annotate`, `compare`, `fullscreen`, `resize`, `move`, `layout`, or `theme` operation.

- Update by calling `show` with the same ID.
- Annotate with targeted `say`.
- Compare by showing another object with `role: "compare"`.
- Fullscreen with `focus`.
- Layout belongs to Switchboard.
- Theme belongs to the design system.

## Validation requirements

Production transport should reject:

- unknown operations
- missing or empty IDs for object operations
- unknown object types
- non-finite chart or progress values
- payloads above the configured size limit
- HTML in text fields unless explicitly sanitized
- pixel coordinates or CSS-like layout instructions

## Compatibility

The protocol is intended to be versioned independently from the renderer. Additive object data changes are preferred. A new operation requires a concrete interaction that cannot be represented by the six existing operations.
