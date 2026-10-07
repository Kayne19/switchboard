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
| `ChartPrimitive` + `chartGeometry` | chart kinds (line, bar, area, scatter), the frame a chart is drawn in for its slot (never text below the page's type floors), geometry, round value ticks, axes and category labels (wrapped down the left), the legend (on at most a quarter of the frame's height, the series past it counted in one last item), traces, a marked bar's outline and printed value, the marker's ring and a hollow ring on a point whose note is off the chart, semantic series colors |
| `DiagramPrimitive` + `diagramLayout` | node layout, edge routing, portrait and landscape topology, a graph recomposed for its viewport, node corner tags inside the frame |
| `SequencePrimitive` + `sequenceLayout` | actor columns, lifelines, message rows, arrowheads by kind, label wrapping over a span, a sequence recomposed to its viewport's width, headers in full or compact by the share of the view they would take pinned, the NOTE marker in the header of the actor a note names |
| `DrawingViewport` + `drawingFit` + `drawingScroll` | a drawing's scale (never text below the page's type floors), scrolling one way inside its clipped viewport, pinned headers; where a scrolled drawing rests (never a part cut at the edge it is read from), the keys that move it from rest to rest (the one key rule every scroller takes, `scrollMove`, and the one page, `PAGE_SHARE`), the rails on the edges it continues past (counts, fades, the names of lines leaving the view), its map in a strip of its own beside it |
| `drawingKit` | what a graph and a sequence draw alike: the path through points, the frame with stepped corners (each drawing its own cuts), the label on a backing measured before it is drawn, portrait once a viewport is a little taller than wide, the glows of a lit line and a lit frame, the entrance stagger (`entranceStep`: the last part in within about a second however large the drawing) |
| `textCells` + `textWrap` | how much room text takes in the monospace face, in cells (a wide character two, a combining mark none; a cut never splits a character), and the one greedy wrap every drawing sets its own labels with (at spaces, a trailing separator kept on its line, a word too long broken after a separator or before a camel-cased word) |
| `ListViewport` | an HTML list that outgrows its slot (tasks, messages, events, forecast days, a table's rows, source, a document's body): scrolling up and down inside its frame under a pinned head (and under a band pinned at its top, a table's header), opening on the item a note names, and on each edge it continues past the scroll rim a drawing has (`ScrollRim`) counting the items that lie that way, and the keys every scroller takes; the aux row under a primary is one, counting its panels |
| `ScrollRim` | the edge every scroller draws where it continues past (a drawing, a list, a calendar's paged days): the fade, the dashed cut line, and the count with its chevron, where a tap turns a page that way |
| `TimerPrimitive` + `timerReading` + `usePageClock` | countdowns on the page's one clock (one timeout, set for the soonest turn of a countdown shown, on the fraction of a second its end falls on; none while nothing runs), the boundaries a countdown reads (rounded up, done at exactly zero, the time since, paused held, a start to come), the bar of the share gone (stepping with reduced motion), the grid or list a set of timers takes for its box, and the height it asks of a box sized by it (its rows', or the least grid of readable cells at its width where that is less) |
| `WeatherPrimitive` + `weatherLayout` + `WeatherGlyph` | the thirteen condition glyphs, the conditions now as the hero, the hourly strip thinned by its width, the days on one shared scale, the alert in the warning colour, how the three stand for the box, the days to come as a row of whole columns beside the conditions in a slot too short for a list, the condition beside the temperature in one shorter still, the place said once beside a title that names it |
| `CodeViewport` | syntax presentation, safe scrolling, irregular clipping |
| `DocumentViewport` | readable document layout and bounded scrolling |
| `CalendarPrimitive` + `calendarLayout` | a calendar's four views (a day or week time grid, a Monday-first month, an agenda) from the box it is given, inside the panel frame's steps, the hours a grid shows and the empty ones it folds, overlapping events side by side or stepped, an event cut at midnight, all-day bars in lanes, a busy day's count, a week paged where its columns do not fit, today and the now from the data (today's date on a square orange tag under an orange rule; the now's time on a pointed tag and a thin rule across today only, under the events), the NOTE badge on the item a note names |
| `MetaTitle` | an object's title on its own meta line (table, calendar, to-do list, inbox): shown in an aux cell and in focus, left out under a scene frame that already shows it; every meta line and its title inked alike (`.meta-line`, `.meta-line__title`) |
| `MetricsPrimitive` | metric alignment and semantic values |
| `TasksPrimitive` | a to-do list: sections by group, the step glyph for a task's state, the priority arrow, the due day judged against the list's `today`, done tasks quieter and counted where a slot is short of room, the compact rows beside a primary |
| `InboxPrimitive` | an inbox: messages in the order sent, the columns of senders, channels and times, a snippet cut on its one line, the time of day on `today`, the unread, flagged and tinted marks, one line or stacked by the list's width |
| `AnnotationCard` | targeted explanation and rich text semantics; its TARGET line names what it is about in its object's words, never an id (`noteTarget`: the chart point, the node, actor or list item, else the object itself: its title, subject, label, alt text or place, else what the page shows of it, else its type's name), beside the tag or on a line of its own, and carries the NOTE badge (`NoteBadge`, the HTML twin of the drawings' `NoteMarker`) beside it where that part is marked; a marked list item, timer or forecast day or hour carries one mark (`--marked-edge` on the side it is read from, a `--marked-wash-*` fading from it) |
| `ChartNotes` + `notePlacement` | every note on a chart, laid over it clear of the others, their points and what the chart draws (`chartObstacles`: bars and scatter points as areas, lines, the rings, a bar's printed value, legend and axis labels; an area's fill only where nothing else is free); on a bar chart a card wholly in or out of the plot, its leader onto the bar from past its end; on a line, area or scatter chart a card above or below its point, across the plot's border where that is clear, its fading angular leader onto the point on the line; a card's width where its own has no clear place; where a card has no place that keeps those rules, one note handed to the rail (the one whose absence leaves the fewest cards astray, a note naming no point first among those); past five notes on one chart, bounded work (no note to the rail, no narrower widths, the search for a clear place for the first five cards only); through a resize, a placement once a step of the size, the cards following their points between, and a placement where it rests |
| `SceneShell` + `RailDetails` | the rail beside or under the main column; under it (a portrait stage), Damocles at its size beside the note read whole, the rail as tall as the note needs with the main column keeping the larger share (`useRailFit`), the note leading a column too short for all it carries with the rest scrolling under it (`ScrollRim`'s fade on an edge it continues past), the activity panel at the column's foot only where it fits whole; a live response faded where its own box cuts it (`useScrollEdges`); a chart's handed-over note in a band under the charts where the rail stands under them |
| `FocusableSurface` | accessible activation without invalid button-wrapped scroll regions; a click or key a control inside it has handled (`preventDefault`) is left alone, and no control stops one, so the page hears every tap; the page's focus ring drawn over what it holds |
| `FocusLayer` | shared-object expansion and return behavior; the notes about the focused object (every note on a chart, the first note naming any other), beside or under it by the box's shape, what they name marked in it |
| Controller reducer | six-operation state semantics |

A page-level patch that duplicates one of these responsibilities is usually incorrect.

## Motion grammar

| Event | Meaning |
|---|---|
| New object | Resolves out of the void, then becomes sharp |
| Updated object | Changes in place without being recreated |
| Removed object | Content de-resolves, then its frame withdraws |
| Recomposition | Existing objects move and resize continuously |
| Focus | The same object expands through a shared layout identity (under reduced motion, its focus fades in over it) |
| Annotation | Explanation resolves near its semantic target |
| Clear | Content recedes until only Damocles remains |

Ordinary structural motion should remain quick, generally about 200 to 500 ms. Idle motion and rare flourishes may be slower. Respect `prefers-reduced-motion`: under it no element moves or resizes. A recomposition is drawn where it ends, and no element is handed to motion's layout projection (`useLayoutMotion`), so no box can be left at an old size; focus fades in over the object, which stays in its slot; a scene change crossfades, the last scene fading out where it stood as the next fades in, and the leaving scene lets Damocles go at once, so there is one; reveals (clip, blur) and opacity still play.

## Focus ring

Every control the keyboard reaches draws the page's focus ring: one orange line, 1px (`--focus-ring` in `styles/index.css`). The browser's own ring is never drawn, and no box clips the ring.

- A control (a button) draws it 4px off itself (`--focus-ring-offset`). A control at an edge that clips stands in from it by the ring's reach (`--focus-ring-reach`), as the HISTORY buttons do at their card's right edge.
- A region fills a box that clips past its edge, so it draws the ring inside its own edge, a pixel in (`--focus-ring-inset`), so a box that a scroll cuts a fraction of a pixel short still shows it. A scroll draws it as its outline, which stays put as the content moves; every box that scrolls takes it, since Chrome puts a scroll with nothing to focus inside it in the tab order. A region with parts over its own edges draws it over them: an object's surface (`FocusableSurface`) over what it holds (the object's box clips everything outside it, and a part with a ground of its own would cover an outline), a calendar's paged days over their rims, a list's or a drawing's scroll over its rims and its pinned head, on the box it scrolls in.
- A scroll that holds controls (the rail, the aux row) brings a focused one into view with room for its ring (`scroll-padding`).
- A metric card in a cluster is clipped to its chamfer, which would clip an outline away; its edge is already a line, so it lights that edge in the ring's colour.
- A text field shows focus by its caret and its field's border (the history's composer).
- A control's name says what it does, the same for the same control: both HISTORY buttons are "Open conversation history".

## Change policy

Before modifying a locked primitive:

1. Reproduce the issue using a canonical fixture.
2. Confirm that the issue belongs to the primitive rather than one scene.
3. Fix the primitive once.
4. Run unit, design-lock, and visual tests.
5. Review all canonical aspect ratios.
6. Update golden screenshots only with explicit design approval.
