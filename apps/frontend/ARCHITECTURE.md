# Architecture

## Data flow

```text
Damocles or development sandbox
             |
             | six-operation protocol
             v
      Controller reducer
             |
             | normalized semantic state
             v
       Scene classifier
             |
             | primitive composition
             v
       React scene renderer
             |
             | layout identities and transitions
             v
      Motion + SVG + CSS
```

## Controller state

The reducer stores semantic objects by stable ID, insertion order, speech state, listening state, and focused object ID.

Stable IDs are critical. Reusing an ID for `show` updates the object in place and allows React and Motion to preserve continuity.

```ts
interface ControllerState {
  objects: Record<string, SceneObject>;
  order: string[];
  speech: SpeechState | null;
  listening: boolean;
  focusId: string | null;
  revision: number;
}
```

## Scene classification

The renderer does not load bespoke route pages. It derives a broad composition from the primary semantic object:

| Primary object | Composition |
|---|---|
| none | idle |
| message | conversation |
| chart | training and analysis |
| diagram | architecture and flow |
| document | email and document reader |
| code | source and diff analysis |

Additional metrics, progress, notes, comparisons, and speech modify that composition incrementally.

## Layout

The stage is a CSS size container. Layout rules use container-relative units and aspect-ratio container queries. The implementation intentionally avoids phone, tablet, iPad, laptop, and ultrawide branches.

```text
horizontal field
| edge | primary content | semantic gutter | presence rail | edge |

vertical field
| primary content |
| explanation + presence |
| shared footer |
```

The renderer can later evolve into a more general constraint solver without changing the model protocol.

## Motion

Motion owns semantic continuity:

- `layout` animates recomposition when objects are added or removed.
- `layoutId` preserves object identity through focus transitions.
- `AnimatePresence` resolves new and removed objects.
- SVG paths trace charts, diagram routes, and technical frames.
- CSS and motion values drive the continuous Damocles float.

Motion is an implementation detail. It must not appear in the model-facing protocol.

## Transport boundary

The expected production boundary is a bidirectional WebSocket:

```text
Damocles backend <-> WebSocket adapter <-> controller.dispatch(action)
```

The transport adapter validates incoming actions, dispatches them, and reports user interaction events back to the backend. It must not contain layout logic.

## Extension strategy

Add a new content type in this order:

1. Define its semantic data type.
2. Implement one reusable primitive.
3. Add focus behavior.
4. Add it to scene composition rules.
5. Create a canonical fixture.
6. Add reducer or rendering tests.
7. Add visual references at approved geometries.

Do not add a dedicated page unless the content genuinely requires a new composition family.
