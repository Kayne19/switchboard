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
| table | ruled rows of named columns |
| image | figure: a raster image contained on the black field |
| calendar | a day, a week, a month or an agenda of events (`src/primitives/CalendarPrimitive.tsx`), laid out from the box it is given |
| tasks, inbox | the to-do list and the inbox, drawn by `TasksPrimitive` and `InboxPrimitive` in the list viewport |
| timer, weather | the timer by `TimerPrimitive` on the page's one clock (`src/hooks/usePageClock.ts`), the forecast by `WeatherPrimitive`, each laid out from the box it is given |

Additional metrics, progress, notes, comparisons, and speech modify that composition incrementally. Any other visual on stage that the composition does not draw itself (`besideVisuals` in `src/app/sceneModel.ts`) goes in the aux row under the primary; see "Scene shell".

## Scene shell

Every composition is drawn by one `SceneShell` (`src/components/Scenes.tsx`).
The shell owns what every page has: the frame and heading, the Damocles
presence, the rail (metrics, live response, note, progress, tool activity),
the footer and corner text, and the transcript entry point. A composition
only fills the main slot and names what its rail carries. A feature that
crosses compositions is added to the shell once; it is never wired into a
composition by hand. The presence reads the voice level from the registered
voice runtime, so no page can leave it out.

The shell also owns the main column (`MainWithAux`): a composition's main
slot over the aux row. A composition names the objects its slot does not
draw (`SceneContent.aux`), and the shell gives each a framed cell in the row
(`AuxRow`), so an accepted visual is never lost to the layout. The slot sits
in the column whether or not the row is shown, so a visual arriving beside
the primary resizes it in place. Alone, a scene's slot fills the column: a
chart, diagram, document, code, table or image page is drawn exactly as it
was before the column existed, and the composed workspace no longer keeps
an empty row's gap under a lone primary.

Two exceptions are deliberate (decided 2026-10-02; see #121 and #124). Review them
in a later refactor or audit instead of folding them in by habit:

- `UnavailableStage` (`src/components/SceneRenderer.tsx`), the fallback page
  shown when the display cannot render, is drawn outside the shell. It draws its
  own presence. The fallback must still work when the shell is what failed, so it
  depends on as little as possible.
- The idle page shows no tool activity panel. Idle stays idle.

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

The production boundary is a bidirectional WebSocket:

```text
Damocles backend <-> src/runtime/callRuntime.ts <-> src/integration/runtime.tsx <-> controller.dispatch(action)
```

`callRuntime.ts` owns the socket and the call's audio and reports runtime
state and each backend message, decoded into the `ServerMessage` union of
`src/protocol.ts` (a frame that is not one of its messages is dropped); it
owns no DOM. `runtime.tsx` validates
incoming display actions, dispatches them, and reports the rendered scene back
to the backend. Neither contains layout logic.

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
