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

Set the listening state without replacing the current scene.

```json
{ "op": "listen", "on": true }
```

### `clear`

Remove content and return to the Damocles presence.

```json
{ "op": "clear" }
```


## Value normalization

`progress.value` is normalized before it reaches the renderer: values in
0–1 are read as ratios, values in 1–100 as percentages, and values outside
0–100 are clamped to the nearest end. Both `1` and `100` land on a full
bar, so a value of exactly `1` always means complete, never one percent.
The fill, the `aria-valuenow` (as a rounded percentage), and the reported
state all derive from the normalized ratio, so a model that sends `65` for
"65 percent" renders a 65% fill. The display tool asks models for
percentages.

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
