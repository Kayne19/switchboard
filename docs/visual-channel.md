# Visual Channel Capabilities & Deferred Proposals

`docs/display-tool.md` is the wire contract for the **general `display` channel**; this document records the implemented capabilities, the composition model, deferred proposals, and refused patterns.

## Core Principle

The visual stage exists to answer questions that are expensive to ask or answer out loud over audio. Visual payloads must compose with speech rather than compete with it (e.g. "I am on step three of five" is effective spoken prose because the screen presents the full plan).

The stage exists only while there is something real to show. With no artifact,
it collapses and conversation becomes the workspace. The same canonical views
(`auto`, `visual`, `comms`, `system`, `theater`) are controlled by visible
buttons and the agent's `view` tool. Explicit caller focus remains pinned until
the caller returns to Auto. The browser reports the resulting `screen_state`,
so an agent can inspect what is visible rather than assuming its request won.

`docs/frontend-command-station-architecture.md` is the product contract for
this composition behavior.

## Implemented: the general display channel

The agent has **one** `display` tool (not a per-kind menu). A call is a protocol
action — `op` + `id` + `type` + `role` + `data` — and the agent decides freely
what to show and how to compose it. The page owns pixels, theme, and layout; the
agent sends semantics. See `docs/display-tool.md` for the full action protocol.

### Content types (the agent's palette)

| type | use |
| --- | --- |
| `diagram` | relationships and structure — structured graph data (`mode: "graph"`, nodes and edges with semantic states) — or an exchange over time (`mode: "sequence"`, actors across the top and messages between them in order, each a `call`, `return` or `async`, any of them marked `active`) |
| `chart` | quantitative series — `kind` is `line` (default), `bar`, `area` or `scatter`, over a numeric x or categorical `labels` |
| `metric` | a single tracked value, with the way it moved (`trend` arrow, `delta` text) when that matters |
| `progress` | a bar, and under it the plan it measures: `steps` with a state each (`done`, `active`, `todo`, `blocked`) and a detail |
| `document` | headings, paragraphs, bullets, code blocks |
| `code` | code and diff views (`add`/`del`/`ctx` lines) |
| `table` | rows of named columns: results, comparisons, inventories; cells carry semantic colour and rows can be highlighted |
| `note` | a persistent annotation, independent from the live transcript |
| `image` | a raster figure (PNG, JPEG or WebP bytes, inline) the agent already has: a plot, a screenshot, a photo |
| `calendar` | a person's time: a day, a week, a month or an agenda of events, all-day or timed, with today and now marked |
| `tasks` | a to-do list in groups, each task with a state, a due date or time, a priority and tags; overdue measured against the list's `today` |
| `timer` | kitchen timers and reminders, counted down on the caller's screen |
| `weather` | conditions now, by the hour and by the day, in the agent's units |
| `inbox` | messages from any channel in the order the agent lists them, unread and flagged ones marked |

Diagram node styling stays restricted to semantic classes and states, enforced server-side.

A sequence diagram is the same `diagram` type under `mode: "sequence"`: the
agent names the actors and the messages in order, and the page sizes the
columns to the labels and wraps a long message over its span. A self-message
draws as a loop; a `return` is dashed; an `async` message has an open
arrowhead; an `active` message glows like an active edge of a graph. How a
graph or a sequence too large for its slot is drawn is the next section's
rule.

### Diagrams that outgrow the frame

Agents send diagrams of the size of what they explain: the switchboard's own
parts are twenty-odd nodes with long names (fixture `topology`), a CI
pipeline is forty steps in layers ten wide (`pipeline`), a call traced end to
end is eight actors and thirty messages (`trace`). Scaled to fit a slot,
those drew their text at 1 to 4 px. One rule now holds for both diagram
modes, wherever the drawing is placed (the diagram slot, a composed
primary's shorter cell, an aux cell, focus):

1. **A drawing never shows its text below the page's smallest type.** The
   floor is the page's own: the `.micro` face never sets below 7px, the
   `.tech` face below 8px (`TYPE_FLOOR_PX` in
   `apps/frontend/src/design/tokens.ts`, held to the stylesheet by a test).
   A graph's node subs and NOTE marker (9 units) and a sequence's actor
   subs keep the first, its labels the second; for a graph that is a scale
   of 7/9. A node's detail line is a dim tertiary note and may fall below.
   A drawing that fits its viewport at that scale or more is contained, as
   large as fits, as before; one that would overflow by a sliver (4%) is
   contained too, rather than scrolled for a few pixels.
2. **Past that, it scrolls inside its viewport, one way where it can.** It
   is drawn at the readable minimum, fills the other axis up to its own
   size, and scrolls along the axis it overflows. The viewport is clipped
   to its box, which in the diagram slot stands between the frame's rails,
   so a drawing neither crosses the frame nor meets the rails. It scrolls
   only when it overflows. It opens on the node its note names (or on
   where it begins) and keeps the reader's place through an update that
   does not change its shape; a sequence keeps its actor headers pinned at
   the top as its messages scroll under them; the keys that scroll it
   scroll it rather than expanding it. How it tells the reader where they
   are is the next list. A drawing that scrolls places no callout, which
   could sit out of view: its note stays in the rail and the node, or the
   sequence's actor, carries the NOTE marker, the rail badge's twin.
3. **It is recomposed for the viewport, not scaled down.** A graph that
   does not read whole is laid out again for a frame of the viewport's
   size at the readable minimum, once in each direction: a layer too wide
   for the frame across wraps into several (its edges pass the other parts
   as long edges do), every layer whose boxes fit the frame across keeps
   inside it, and a top-down drawing in a narrow frame wraps its node text
   narrower. Every edge stays one a reader can follow: each end leaves or
   reaches its box at a port of its own (a box grows along a side too
   short for its ports), so no two arrowheads stack; of more than four
   long edges running side by side through a layer, the longest are drawn
   as stubs; and in a drawing more than two frames long, an edge longer
   than the frame, whose ends cannot both be in view, is drawn as a stub
   pair instead: a short line from its source to `-> target`, and one from
   `source ->` into its target, the edge's own label set quieter under the
   name (a feedback edge read across the page runs right to left, so its
   arrows read `target <-` and `<- source`). The stubs leaving one side of
   a node the same way, in one colour, lit or not alike, share one line and
   one list of names; the names stand in the layer next to the node. On a
   phone most of a dense graph's edges become stubs. Of the two and the drawing as first laid out,
   the one asking the least scrolling is kept (a viewport's worth of
   reading is the unit, so scrolling both ways costs most), the stage's own
   direction preferred. A sequence too wide is recomposed to the
   viewport's width: the columns share it, headers wrap and, when they
   must, stand in two staggered rows (never with a name cut mid-word),
   and a label that does not fit between its lifelines takes its own line
   over its arrow, so the exchange grows down, in the order it runs. It
   scrolls across only when its actors' names alone, two columns to a
   word, are wider than the viewport at the minimum (a dozen actors in a
   phone's aux cell). Its headers are pinned while it scrolls, so their
   depth is taken from every view of the exchange: where its headers in
   full (each actor's name and its `sub`) would take more than three
   tenths of the view's height, they are compact, the names alone in
   shallower boxes, the NOTE marker beside its actor's name rather than
   under it. On a phone that is the difference between three messages in
   view and six. A view with the room (a wider or taller slot) keeps the
   details, and so does focus, where the reader went for the whole
   exchange, unless even there they would take half its height.
4. **Focus gives it the stage.** The same rule runs in the focus layer's
   larger viewport, so focus shows more of it at once. Focus keeps the
   note about the diagram, which the rail carried: the node or actor it
   names keeps its NOTE marker, a graph opens on that node, and the note
   stands in a panel of its own, beside the drawing when the focus box is
   wide (where the rail stood) and under it when the box is tall (where
   the drawing needs the width). There the note is never a callout on the
   drawing as well.

A drawing that scrolls says where its reader is, in the frame's own marks
rather than with a scroll bar (`primitives/drawingScroll.ts` decides,
`DrawingViewport` draws):

- **It rests between its parts.** A view at rest never has a node (or a
  sequence's message) cut at the edge it is read from: the places it may
  rest put that edge in a gap between layers, the next part clear of the
  edge's rail, an edge label in the gap kept whole when there is room.
  Touch settles there through the browser's scroll snapping; the keys
  that scroll a focused drawing move it from one such place to the next
  (an arrow to the next, Space or Page Down a page on, Home and End to
  the ends); a wheel or a trackpad moves freely and settles when it
  pauses, a single notch on to the next place; a mouse wheel over a
  drawing that scrolls only across scrolls it across. It opens on its
  lead at such a place.
  At its far end it rests the same way, showing a little black past the
  drawing's end rather than a cut part. Across a drawing that scrolls
  both ways there may be no gap every row leaves: it rests where the
  rail cuts the fewest parts. The far edge of the view can still cut the
  part beyond it: there a fade as deep as that part reaches in makes it
  read as the next one coming.
- **Each edge it continues past carries a rail.** A dashed orange line on
  the cut, the count of what lies that way ("13 NODES", "23 MESSAGES")
  and a chevron pointing there; a tap on the count turns a page. Text on
  the left and right rails runs along them, so a rail costs the drawing a
  line of small type. A tap on a count or on the map does not expand the
  object, as a tap on the drawing does; the control marks the tap handled
  and lets it go on, so the page still hears it as the gesture that lets
  it play audio (`FocusableSurface`: no control inside it stops an
  event).
- **A line that leaves the view says where it goes.** On the rail where
  it crosses, the name of the node at its far end, in the line's colour,
  pointing out; several lines to one node are one name.
- **A map shows the whole.** A drawing that scrolls 1.6 views or more
  carries a small map: every node and line, the view boxed in orange. A
  tap or a drag on it moves the view. The map stands in a strip of its
  own beside the drawing, along the way it scrolls (under a drawing that
  scrolls across, right of one that scrolls down), and the drawing is
  laid out for the rest of the viewport, so the map covers none of it,
  at rest or moving. A drawing in a viewport too small for a map (a
  phone's aux cell) has its rails only, and so does one the strip would
  cost its reading: one that would scroll a way it did not beside it, a
  graph that would turn, or a sequence whose headers would change
  (compact, or in two rows).

Why a map, rather than opening on the whole drawing and then moving in to
its anchor: an opening overview is gone a second later, a reader who
prefers reduced motion never sees it, and it says nothing once the reader
has scrolled. The map is there whenever the reader looks, says where the
view is as well as what the whole is, and is a way to move. Why a strip
rather than a corner over the drawing: a layered drawing fills its frame
across, so no corner is free at every place it rests, and a map over a
stub's names or an edge's label hides what the reader came for. The
strip costs the drawing a band as deep as the map (held to 40 px) and its
margins, 60 px at most, the way a scroll bar would. Hidden scroll bars lose
nothing: the rails and the map say more, in sharp geometry, and a bar on
a phone is not shown at all.

Why this rule and not another. A diagram exists to be read; a drawing too
small to read is not a smaller answer but no answer, and the caller cannot
pinch-zoom a page they are holding on a call. Scrolling is how this page
already handles content larger than its frame (code, documents, tables, long
plans), inside the frame's viewport and only when it overflows, so a large
diagram scrolls by the same rules rather than shrinking. The floor comes
from the page's own smallest type rather than a new number, so a diagram is
never the least readable thing on screen. Recomposing rather than scaling
is the portrait rule: a phone reads a graph top down with its wide layers
wrapped, and a long exchange as a column, instead of a desktop drawing at a
third of its size. A dense graph (the forty-step pipeline) in a phone's
slot reads top down and scrolls one way: wrapping its layers would
multiply the long edges past them, so those become stub pairs, and the
drawing reads as a column of steps, each with the names of its far ends
beside it. It is long (some sixteen screens of a slot a third of a phone
tall); that is the price of forty steps at a readable size. A stub pair is
the standard answer to an edge too long to follow (an off-page connector),
and the threshold is the frame itself: past one frame's length the reader
can no longer see both ends, and has to track the line through the scroll
among its neighbours.

A chart's `kind` says how its series are drawn, and the page decides the rest
from geometry. Categorical `labels` replace the numeric x ticks; when a row of
them does not fit, the page staggers them onto two rows, and when even that
does not fit it draws every n-th label. A bar chart whose labels do not fit a
row is drawn with its bars running across and a labelled row per category,
as long as the rows fit the plot; otherwise its labels are staggered or thinned
like any other chart's. Down the left a label takes at most three tenths of
the width: a longer one wraps onto as many lines as its row holds (up to
three), after a space or a path separator where it can, and is cut only past
them -- a path at its start, so its file name stays. There is no pie chart and
no sparkline: a single series with no axes is a `metric`, and a share of a
whole reads better as a bar per part.

The value axis is read off round numbers. An end the agent gives (`yMin`,
`yMax`) is kept; an end the page chooses is rounded out to a step of 1, 2, 2.5
or 5 times a power of ten, and a bar or area chart first leaves a tenth of its
span past its tallest value, room for a note inside the plot. A chart that
gives both ends is labelled at four even divisions of it, as before. A
percentage that must stop at 100 says `yMax: 100`.

A point that a `marker` or a note names is marked, its value printed where a
leader lands. A bar is marked as a bar: outlined in the annotation colour, its
value printed past its end. A point on a line, area or scatter chart gets a
ring, drawn whole even on the plot's edge (hollow on a scatter, round the point
it marks), and its value printed by the ring as precisely as the series is
written: above or below it, where a leader comes straight onto it, by
preference; run off to one side of a line that rises across the other; beside
it where above and below have much less clear room past them (a peak whose
line falls away under it, a point on the plot's top or bottom edge); past an
area's line rather than over its own fill; and clear of the axes' text.

A chart is drawn in a frame its slot decides, by the slot's geometry alone.
The approved 1000x500 canvas holds wherever it reads: its text at or above
the page's type floors (the same `TYPE_FLOOR_PX` the diagrams keep), and the
slot no more than a quarter taller than the canvas drawn across it; a slot
wider than the canvas keeps it whole, the room beside it the notes'. Anywhere
else -- a phone, a portrait tablet, a chart in an aux cell, a portrait focus
-- the chart is recomposed: its frame takes the slot's own shape, so the plot
fills the slot rather than shrinking inside bands of black, at the scale that
fits but never under the readable one. A bar chart whose labels then no longer
fit a row under its bars turns on its side. One too long for a row per
category even there (sixty bars on a phone, whose stage it has been given)
stays on its side in a slot taller than it is wide, drawn at its least
height, and scrolls in its frame as a list does: the rows past each edge
counted there, a tap turning a page, the value axis pinned over the rows,
its notes lying on the chart and scrolling with the bars they name; it opens
on the bar a note names. A wide slot stands such a chart upright, its labels
thinned, the whole of it in view. A slot too small for the chart's
least frame (320x240 units) at that scale draws it smaller; an aux cell keeps
a chart's cell at least that tall, so the aux row scrolls instead.

A progress object with `steps` may omit `value`: the service fills in the
share of steps done, so "I am on step three of five" is spoken while the
screen shows the five, their states, and a bar that agrees with them. The
page decides how much of a long plan each slot shows; the whole plan is a
focus away. A plan reads best beside the work it is about: shown next to a
visual primary it is a module in the rail, read the way the metrics above
it are (its label and share done on one row, the steps still to do under
the bar). Shown as the primary, its frame fits the plan and sits in the
middle of the column, and only a plan longer than the column fills it.

### A primary that outgrows its slot

On a portrait stage the rail -- metrics, progress, the live response, the
note, tool activity and Damocles -- stands under the main column, and the
column keeps 59% of the stage. A primary that reads whole there keeps that
layout. One whose content asks for more gets the stage's height:

- **What counts as more is the content's own word, never its type or the
  screen's size.** Each primitive that can outgrow its viewport says how
  much taller than the viewport it would have to be to be read whole
  (`hooks/useStageDemand.ts`): a drawing the height it reads in at its
  least readable scale (a fit made for another viewport, as before its
  host is measured, says nothing); a table, code pane, document or plan
  the height of what it scrolls through; a figure its height drawn across
  its field's width, never past its own size; a bar chart whose labels do
  not fit under its bars the height in which it lies on its side with a
  labelled row per category; a calendar's hour grid and a forecast laid
  down the box, which grow to fill whatever view they get, the height
  their parts read whole in. A primitive laid out for its box (a
  calendar, a forecast, timers) says nothing until it has measured the
  box: the stand-in it draws before then is not what will stand. Only the
  primary speaks: a plan under a chart or a table in the aux row never
  folds the rail.
- **The shell decides** (`app/stageFold.ts`): where the rail stands under
  the column (measured, not a media query), a primary whose content is
  more than a line of text past its viewport in the layout it shares with
  the rail takes the stage. On the stage a content is weighed against the
  viewport it had in that shared layout, never against a model of the
  frame round it (a table's head, a document's heading, an aux row are
  fixed; a diagram's rails grow with it). Folded, it gives the stage back
  only once it would be within a few pixels of reading whole there, so a
  need on the line does not fold and unfold as it redraws. So a primary
  sent again with less in it (a week with one appointment left) gives the
  stage back: a viewport that stays the same drawing stays mounted across
  the fold, and keeps what it measured in the shared layout. A graph laid
  out again for the stage's taller viewport, or a drawing the stage's
  height turns into another (a calendar too short for its grid in its
  share draws its agenda there, and the grid on the stage), says nothing
  of the shared layout unless it overflows even the stage, and a
  primitive that cannot tell yet (a drawing whose fit has not followed
  its box) leaves the layout as it is: such a primary keeps the stage
  until another takes its place. A new primary is measured first in the
  shared layout.
  Opening the rail changes nothing of this. A landscape stage, the rail
  beside the primary, never folds.
- **The rail folds to a strip under the primary, down to the footer's
  band.** The strip shows the note (held to three lines, its target line
  naming what it is about, and on a diagram the NOTE marker on the node or
  actor it names), or the live response where there is no note, beside a
  smaller Damocles whose caption still names the tool at work. A tap on
  the note expands it in focus. A live response streams at its newest
  three lines. Its top rule is a handle, a finger's reach tall round the
  thin rule: it names what the rail keeps folded (the rest of a cut note,
  the metrics, progress, the live response, activity) and opens the rail
  as it was, the primary back in its share; from there it folds again.
  Its accessible name holds the words it shows. What it folds is set
  aside by the stylesheet, not taken out of the page, so folding draws
  nothing afresh. The caller's choice holds for that primary.

At 390x844 a diagram's viewport grows from 374 px to 460 px, a 40-row
table's from 436 to 544, and a bar chart of 45 categories names every one
instead of every eighth. Why fold the rail rather than scroll the page or
shrink the primary: the page never scrolls as a whole (its frame and
Damocles stay put), and a primary drawn smaller is the squeeze this
answers. The note is what the caller most needs from the rail while they
read a large primary, so it stays, and stays linked to its item; the
metrics are a tap away.

### Personal-assistant views: time is data

The `calendar`, `tasks`, `timer`, `weather` and `inbox` types let an agent on
a call act as the caller's assistant: the week ahead, what is left to do,
the pasta timer, whether to take an umbrella, what came in overnight. The
wire rules are in `docs/display-tool.md` ("Time values" and
"Personal-assistant types"); the reasons are these.

- **Times are text in three forms.** A date (`2026-10-05`), a wall time on
  the caller's clock (`2026-10-05T14:30`) and an instant with its offset
  (`2026-10-05T14:30:00-07:00`). One parser on each side reads all three,
  and every type uses it, so a calendar and a to-do list cannot disagree on
  what a date is. Each time has one spelling (upper-case `T` and `Z`), so a
  note can name a forecast hour by its text.
- **No page clock and no time zones, except for a timer.** The page draws a
  calendar, a to-do list, a forecast and an inbox from what the agent sent
  and nothing else. "Today" and "now" are fields the agent fills in, so
  the now line on a calendar, an overdue task and a message from this
  morning come from the data, not from the browser. The agent knows the
  caller's day; a browser may be in another zone, or its clock may be
  wrong. A frame is then the same on every screen, and testable without
  faking a clock. A timer is the exception, because a countdown has to
  move: it takes instants, and the page counts it down against its own
  clock, shows it done at zero, and plays no sound (the agent says so).
  With reduced motion the numbers still change; nothing sweeps.
- **The agent sends the day; the page draws it.** The agent sends no grid
  of hours, no widths and no glyphs. The page decides: a wall time with no
  end is a half-hour block; sections stand in the order their groups are
  first met; a weather condition is one of thirteen names that the page
  draws in its own sharp geometry (never an emoji or an image); a message
  at a wall time on `today` shows its time of day, and any other its date;
  a task is overdue when the day it is due is before `today` (there is no
  `now` on a list, so the time of day is not compared).
- **One message in full stays a `document`** of kind `email`; an inbox is
  the list.

Each is a visual like a table: shown alone it takes the main slot, and
beside another primary it takes a cell in the aux row. The fixtures
(`calendar`, `calendar-day`, `calendar-month`, `calendar-agenda`, `tasks`,
`timer`, `weather`, `inbox`, and `today`, an agenda with the forecast, the
to-do list and the inbox beside it) show them. Each of the five has a
primitive of its own.

**A calendar** is drawn by its own primitive: a time grid for a day or a
week, Monday-first rows for a month, a list of days for an agenda, each
laid out from the box it is given rather than the device (a week too
narrow for seven columns pages through them; a grid too short to read
becomes the agenda of the same days; a month too small for titles marks
its days). The wire rules and the drawing rules are in
`docs/display-tool.md` ("calendar").

**The to-do list and the inbox are read as the table and the rail's plan
module are read**: rows between thin rules under a meta line that names
the list and counts what it holds, the prose face for what a person wrote,
the tech face for states, days and counts, no cards.

- A to-do list stands in sections, in the order their groups are first met
  (a section is its heading over its rows). A task's state is the plan's
  own step glyph, its priority the metric's arrow (up for high, down for
  low), its text wraps whole, its detail and tags follow, and its due day
  stands at the row's end, judged against the list's `today`: `OVERDUE` in
  red over the day, `TODAY` in orange over the time, `TOMORROW`, or the
  day. Done tasks step back. A list longer than fourteen counts each
  section's done tasks on one row (`3 DONE`) in the main slot; focus lists
  them all. Where the column has room for two sections at 24em they stand
  side by side, by its width alone.
- An inbox lists its messages in the order sent: the sender, the subject
  and a snippet cut at the end of its one line, the channel as a tag, and
  the time (the time of day for a wall time on `today`, else the day; a
  day in another year than `today`'s gives its year). Unread is strong and
  carries the orange square, flagged the amber flag, a semantic tint runs
  down the row's edge. Senders, channels and times stand in columns. A
  list 50em wide puts a message on one line; narrower, the sender and time
  stand over the subject and the snippet.
- Beside the primary, either reads as the rail's plan module: one line a
  task (its day on one line, done tasks counted, no detail or tags), a
  message as its sender and subject.
- A list that outgrows its slot scrolls inside its frame in the list
  viewport (`ListViewport`): the drawing viewport's fade, cut line and
  count of the items past each edge, and it opens on the item a note
  names. Focus gives it the stage, and keeps that note beside it.

**A note on one item** (`anchor.item`) marks that item wherever its object
is drawn, as a diagram marks the node a note names, while that note is the
one the page draws (the rail's, or the one focus keeps): the item carries
the NOTE badge, the card's twin, and the card's `TARGET` line names it in
its object's words, on a line of its own. A note the rail does not show
marks nothing, so a badge always has its card on screen. Every item
element carries `data-item`, the name a note uses for it, which is also
what the list viewport counts.

### The page clock

A timer is the only thing on the page that reads the time, and it reads
it from one clock (`apps/frontend/src/hooks/usePageClock.ts`): one
timeout for the whole page, ticking on the wall clock's whole seconds
while a countdown on screen is running, and none while every timer is
paused or none is shown. Two timers therefore turn over on the same tick,
and a page with eight timers runs one timeout, not eight. What a timer
reads at a moment is pure (`readTimer`): the digits round up, so they show
`00:01` until the end and `00:00` only at `endsAt`; from that moment it is
done, in the warning colour, and counts how long ago it ended; a paused
timer is held at `remaining` whatever the clock does; a `startedAt` still
to come (the agent's clock ahead of the page's) reads as nothing gone yet,
and the countdown still runs to `endsAt`. The share gone is a bar that
sweeps from tick to tick by a CSS transition; with reduced motion the
transition goes and the bar steps with the digits. Tests drive the clock:
Vitest's fake timers in the unit tests, Playwright's clock in the browser.

### Timers and forecasts in their slot

A set of timers is laid out for its box: a grid whose columns give the
largest countdown digits (no cell beside another narrower than its label
needs), each countdown as large as its cell allows, up to 200px; where no
grid gives readable digits (five timers on a phone, several in an aux
cell) they are rows of a list that scrolls inside its frame.

A forecast is laid out for its box too (`weatherLayout`): on a wide box
the conditions now stand beside the days and the hours run across the
foot; on a tall one the three stand down the box and scroll as one; a
small slot (an aux cell) holds the conditions on one line and one list,
the days or, when the note names an hour, the hours; a slot too short
for a list row (a phone's cell in the today scene) holds the conditions
with the days to come beside them as a row of columns (a first day whose
high and low the figure shows is left out), each its name, glyph, high
and low, as many as whole columns fit beside the figure, a day the note
names taking the last column when it lies past them. The layout counts
the figure's width itself -- its glyph and temperature row (in ems of
the temperature), or its glyph and condition line (read from the page,
whose face follows the stage), whichever is wider -- and stands the
columns only where a whole one fits beside it, the figure drawn at that
width. A slot too short for those columns, or too narrow for one beside
the figure, holds the conditions alone, the condition beside the
temperature where stacked they would run past its foot (on one line, the
high and low giving way first). The hour or day a note names that no
list or column there draws stands on a line under the conditions, its
badge, its name, its glyph and its readings, and the layout keeps room
for that line. Where the line is narrow its readings give way in an
order: the chance of rain goes whole first, then the temperatures end in
an ellipsis. Where a slot is too short for the head, the alert's line,
the figure and that item's line (the today scene's cell at 844x390), the
alert's line gives way to the item's, which the card on screen names:
the alert's tag stays in the head, and focus draws its line whole. The hours are a strip, a column each:
the temperature traced over the chance of rain, labelled every 1, 2, 3,
4, 6, 8, 12 or 24 hours so the labels stand at least 34px apart, which
keeps 48 hours readable on a phone without scrolling sideways; the hour
a note names, each midnight (the day's name) and the first hour are
labelled too, in that order of claim, and one gives way to an earlier
claim within a step of it, so no two labels crowd (a strip that starts
at 23:00 names the new day at midnight, not the hour before it). The
days are rows whose ranges are bars on one scale, the lowest low to the
highest high, so a cold day reads as cold beside a warm one. An alert
stands on an amber rule.

A title shows once. In the main slot the scene's frame carries it; in an
aux cell and in focus, where no frame does, the forecast's head leads with
it (beside it, what of the place it is for the title does not name
already: `CA` beside `WEATHER / SAN FRANCISCO`) and the timers carry it
over their field. The forecast's head names its place in every role.

### Lists that outgrow the frame

A list longer than its slot (a forecast's days, timers in a small slot,
and the other assistant lists) scrolls up and down inside its frame in a
`ListViewport`, the HTML twin of a drawing's viewport: on each edge it
continues past it draws the same fade, dashed cut line and tag, the tag
counting the items that lie that way (a row of which no more than a
sliver shows counts as past the edge), or saying MORE where none does. A
tap on the tag turns a page and does not expand the object; the keys that
scroll a focused list scroll it. It opens on the item a note names, never
under the fade, and keeps the reader's place through an update. Focus
gives the list the whole stage.

### Composition & focus

Objects carry a **role** (`primary`, `compare`, `secondary`, `ambient`) and a
stable agent-owned **id**. The page lays roles out in a responsive grid; the
agent can `focus` a region, `hide` an object, `say` an aside on it, or `clear`
the whole stage — one action per call. The old bespoke `plan`/`timeline`/`diff`
renderers are gone; `progress`, `document`, and `code` are the general primitives
that subsume them.

Any primary can have visuals beside it, so the agent can show a diagram with
the table it summarises, a chart with the image it came from, or code with a
review document. The primary takes the main slot, drawn the way its type is
drawn alone. Every other visual on stage (`chart`, `diagram`, `document`,
`code`, `table`, `image`, `calendar`, `tasks`, `timer`, `weather`, `inbox`) is drawn once:

- A chart beside a chart primary shares the chart row with it; a `compare`
  chart is labelled as the comparison. This is the one scene that has a place
  for a visual beside its primary.
- Every other visual takes a framed cell in the **aux row** under the primary:
  `compare` objects first, then `secondary`, then `ambient` (the rail has no
  room for a visual), each in the order shown.
- Metrics, notes and progress keep the places they have without the row: the
  rail beside the content, and on a chart page the notes over the charts.
  Progress joins the aux row in two cases: under a primary that is itself a
  metric, a progress or a note (with any `compare` object that the rail does
  not already show), and on a chart page with a visual in the row, where the
  progress that sat under the charts moves into the row so the charts keep
  their share of a short stage.

Under a chart, diagram, document, code, table, image, progress or note
primary, the aux row takes what its cells need up to two fifths of the main
column, so the primary keeps the larger share. Under a metric primary the
card keeps its own height and the row takes the rest. Each visual keeps a
readable floor in its cell (the head of a table and its first rows, a chart's
plot, a figure and its caption). When the row has no room for every cell at
its floor, it scrolls inside itself; it never shrinks a visual to nothing. A figure in a short cell is
drawn smaller, never cropped, and a table in a narrow cell scrolls sideways
rather than breaking a word. The cells sit side by side when the column is
wide and stack when it is narrow, from the column's own width. A visual that
arrives beside the primary resizes the primary in place; it does not redraw
it.

Notes are durable objects rather than a mirror of the latest chat response.
They change only through an explicit `show` update to their stable id, `hide`,
or `clear`. A note may carry a semantic `anchor` naming another object's id and
an optional chart `x`/`series`, diagram `node`, or `item` inside a calendar, a
to-do list, a timer, a forecast or an inbox; the browser owns the resulting
placement. On a chart page a note lies over the chart it names, clear of what
the chart draws: a bar or a scatter point is an area, not the line round it,
and a card keeps a few pixels from it; lines, a marked point's ring and value,
a bar's printed value, the legend and the axis labels are kept clear too, and
an area chart's fill is given up only where nothing else is free. The page
looks for such a place anywhere within reach of the named point, including
the band above the plot. The card's tag names what it points at as the caller
reads it, never the object's id or an index the agent sent: the category on a
chart with labels (`TARGET / FRONTEND VISUAL / THIS RUN`), the x axis's name
and the value on any other (`TARGET / EPOCH 32 / VAL LOSS`), and the series
wherever the anchor names one or the chart draws more than one.

On every kind of chart a card lies wholly inside the plot, a few pixels in
from its border, in clear space, or wholly outside it, never across it. Its
leader comes onto the value the chart prints at the point it names, from the
side the value is printed on (past a bar's end, above, below or beside a
point's ring): out of the card's facing edge from a card past the value, or out
of its side, along over the data between and a 45-degree turn onto the value,
from a card beside it. It runs through no other bar, point or line, never
alongside the bar it names, and keeps the card's edge colour, a shade firmer,
to the end. A card with no clear place at its own width, or a long way from its
point, tries narrower widths its text still fits at; one whose text would
scroll at its width takes a wider one. These are the rules a card keeps where
the chart has a place for it; where it has none, the rail takes a note (below),
and a card the rail cannot take -- a second one astray, or one on a compare
chart -- keeps the place that breaks the fewest of them.

A card is astray where the best place the chart has for it breaks one of these
rules: over the data, too far from its point for its leader to read as its
own, with no leader clear of the other marks and lines, across the plot's
border, or over another card or a named point. The rail takes a note from the
chart only then, and only where leaving that note out leaves fewer cards
astray -- the rail is for a card the chart has no place for, never room made
for nothing. Which note goes: the one whose absence leaves the fewest cards
astray; of those, a note naming no point first, since it loses no leader in the
rail; then one that was astray itself; then the one whose absence costs the
others least. So a general note goes only where that gives a card it crowded a
clear place, and an observation with no clear place goes itself rather than
stay over the data while a general note keeps its corner. Every bar and every
point the notes name stays marked while its note is in the rail, and the rail
card still names its target. A note anchored to a visual on a chart page that
is not a chart (one in the aux row) is shown in the rail too. The rail holds
one note, so: only the primary chart hands one over; only the first note about
a visual off the charts goes there (later ones lie on the primary chart, as
before); while it does, the primary hands none over; and a compare chart's
notes stay on it, over its data where it has no clear place.

The note a chart hands over stays readable beside it. Where the rail stands
under a chart (a portrait stage), the note is drawn in a band under it, full
width, carved from its slot, rather than in the rail under its metrics (a
compare pair, which already scrolls in its row, keeps its note in the rail,
leading it): the chart is recomposed to the shorter slot, and the card's target
line names what the marked bar or point is. The band holds the note while it
is on that chart; the chart is not asked to place it again, so a chart laid
out in less room cannot take it back and hand it out again, the band coming
and going. This is the one exception to "the chart keeps its size for its
notes". Where the rail stands beside the charts and is too short for all it
carries (a phone on its side), a note the charts could not hold leads it, at
its whole height, the metrics after it in the column's scroll. A card on a
short chart keeps room for its header and a few lines (up to three fifths of
the layer), so a note too long for that is one the chart hands over rather
than a card whose text scrolls out of sight. Every visual payload may also provide a short `caption` for the
scene's supporting corner label, so that label describes real content instead
of fixed decorative text.

### Replay & state

A reconnecting browser is replayed the full current projection — every
visible object, the current focus, and any pending `say` — via
`DisplayProjection::snapshot_actions()`, not just the single most recent
action. `screen_state.has_visual` / `visual_kind` reflect what the browser
has actually confirmed, so an agent can verify its own display via `view`.

### Confirmed rendering: `seq`, the watermark, and honest results

Delivering an action to the browser is necessary but not sufficient — the
page still has to validate and paint it. Rather than take "sent" for "shown,"
the channel closes that gap with an explicit confirm/reject round trip.

**On the wire.** Every `display` frame the backend sends — live or replayed
on reconnect — is `{"type":"display","seq":<n>,"action":<normalized>}`.
`seq` is drawn from the same monotonic counter that sequences every
delivered event, stamped on just before the frame leaves
(`stamp_display_seq`). A reconnect snapshot stamps every replayed action
with the gate's watermark as of connect time, since the snapshot as a whole
represents the projection at that point in the stream.

**The browser's report.** The existing `screen_state` message (sent whenever
the page applies or declines a frame) carries two more fields:
- `applied_seq`: the highest `seq` the page has actually rendered so far
  (monotonic; it never regresses).
- `rejected` (optional): `{ seq, reason }` for a frame the page could not
  apply. It stays queued — not dropped — until the report that carries it is
  the one actually transmitted, so an intervening, rejection-less report
  can't silently swallow it.

**The backend's watermark.** `AppInner.display_confirm` is a
`tokio::sync::watch<ConfirmState>`:

```rust
pub struct ConfirmState {
    pub generation: u64,
    pub watermark: Option<u64>,   // None: nothing confirmed yet this generation
    pub rejection: Option<(u64, String)>,
}
```

Every `screen_state` report folds its `applied_seq` / `rejected` into this
watch as a running per-generation maximum. Moving to a new leg resets it —
`generation` moves to the new value, `watermark` goes back to `None`,
`rejection` clears — the same reset the projection itself gets (`objects` /
`order` / `focus_id` / `speech` cleared) — so a confirmation left over from
the leg that just transferred away can never satisfy a wait started by the
leg that replaced it.

That reset happens once per leg, keyed by route and generation
(`DisplayGateState::scene_leg`). A transfer is announced twice — by candidate
promotion when the incoming agent first shows life, and by the route callback
when the PBX settles after the intro turn — and only the first announcement
resets the scene and sends the `epoch`. The second restates the status and
leaves the new agent's first drawing, and its confirmation, alone. See
`LegAnnouncer` in `apps/backend/src/leg_announcer.rs`.

**The display call's result.** A display reaches the service as a module
call (the path is under "Explicitly Refused Patterns" below). After
publishing the action and stamping its `seq`, the service's `display`
handler (`apps/backend/src/module_calls.rs`) waits up to ~2.5s
(`DISPLAY_CONFIRM_DEADLINE_MS`) for that `seq` to clear the watermark, then
answers with one of these, which the agent's skill module receives as the
call's `result` and turns into the line it prints:
- `{"delivered": true, "rendered": true}` — the browser confirmed this `seq`.
- `{"delivered": true, "rendered": false, "rejected": true, "reason": "..."}`
  — the browser nacked this exact `seq`.
- `{"delivered": true, "rendered": false, "reason": "no confirmation from
  the browser"}` — the deadline passed with nothing seen.
- `{"delivered": true, "rendered": false, "reason": "the caller's screen
  moved to a new leg before this was confirmed"}` — the call transferred
  while the wait was in flight, so any confirmation still coming is for a
  generation the agent is no longer on.
- `{"delivered": false, "reason": "no browser connected"}` — nothing to wait
  on; the action is still recorded in the projection and greets the next
  connection.

**`view` with no `target`.** Rather than ask the browser what is on
screen right now, the `view` call reports the backend's *own* record of what it
believes it told the browser to show — the same projection that seeds a
reconnect — plus whether that intent is confirmed:

```
{ view, has_visual, visual_kind, title, object_ids, confirmed, connected, stale }
```

`confirmed` is `true` when nothing is on stage (trivially, there is nothing
outstanding to confirm) or when the confirm watermark for the *current*
generation has reached the projection's own watermark. `stale` is exactly
`!confirmed` — see the note below on why that is not the same as
`!connected`.

**Primary-visual precedence.** `DisplayProjection::summary()` (backend) and
the browser's `buildCompositionModel` in `sceneModel.ts` use one unified
rule to pick the object a `visual_kind` / `title` answer is about:

1. the focused object, if `focus` names one and it is still on stage;
2. otherwise the composition **primary**, computed over the objects
   currently on stage in the order they were `show`n:
   1. the earliest claimant holding `role: "primary"`;
   2. else the first object that is not `role: "ambient"` (an unset role
      counts as non-ambient);
   3. else the first object shown, if any is on stage at all.

`role: "primary"` is held either by one non-metric object or by a cluster
of up to nine metrics (`MAX_PRIMARY_METRICS`), which the page lays out
together in the main column in claim order. A `show` that carries
`role: "primary"` demotes every object it displaces to `role: "secondary"`,
where it stays on stage: a non-metric claim displaces every primary; a metric
claim displaces a non-metric primary and joins any metrics holding the role,
displacing the earliest of them only when the cluster is already full. So the
latest explicit claim always reaches the primary viewport, and hiding the
last primary hands the viewport back by rule 2. The composition primary of
rule 2.1 is the earliest claimant still holding the role, which for a cluster
is its first metric. A `show` that names no role keeps the object's current
role, so updating an object never moves the primary; one that changes a
primary's type claims the role again under the new type. The browser's reducer
(`controller/reducer.ts`) and `DisplayProjection::apply` both apply these
rules, and a reconnecting browser's snapshot replays every object in show
order and the primaries' claims in claim order, so it rebuilds both.

Focus always overrides the composition primary, for both `visual_kind` and
`title` — an agent that calls `focus` on an ambient or secondary object
still gets that object reported back. Absent a focus, `role: "primary"`
wins regardless of show order, and a later `show` without that role never
displaces an earlier non-ambient object just by being more recent. The backend's `view`
intent and the browser's own `screen_state` report are computed by the same
rule, so they agree on every composed scene, not just the common single-object
or single-`role:"primary"` case.

**`stale` is decoupled from `connected` — deliberately.** A visual can be
fully confirmed by a browser that has since disconnected: `confirmed: true`
(a past `screen_state` reached the current watermark) but `connected: false`
(no socket right now). Reporting `stale: true` in that case would be false —
the last thing that browser saw really is what the projection still holds —
so `stale` tracks confirmation only, and `connected` is reported alongside
it so the agent still learns the browser is gone and can judge what that
means for a caller who might reconnect.

## Implemented: inline raster images

The `image` type carries a picture the agent already has (a matplotlib plot, a
screenshot, a photo) as `{format, bytes, alt}`: `format` is `png`, `jpeg` or
`webp`, `bytes` is standard base64. It was deferred while the structured types
covered every need; it exists because an agent often holds a figure that no
structured type can redraw. The rules are in `docs/display-tool.md` ("Image v1
rules"); the reasons are these.

- **Raster bytes are not markup.** The structured types are safe because the
  page draws them from data with text nodes. A raster image is pixels the
  browser's decoder reads, never parsed as a document, so it adds no script
  surface. SVG is refused for exactly that reason: it is markup and can carry
  script. `format` cannot smuggle it in, because both validators
  (`validation.ts`, `visual_protocol.rs`) decode the head of `bytes` and check
  it starts with the signature `format` names.
- **The page builds the source.** The `img` source is
  `data:image/<format>;base64,<bytes>`, built by `ImagePrimitive` from the two
  validated fields; there is no URL field, so nothing is fetched and no other
  source can reach an `img`. The agent sends no size: the page reads the
  intrinsic size on decode and fits the figure to its slot (contained, never
  cropped or zoomed). `alt` is required; it is the alt text, and the title
  when there is none.
- **One transport, a per-type cap.** An image travels in the ordinary display
  action, through the same validation, projection, confirmation and replay as
  every other type. There is no second upload path; instead an image `show`
  has its own size cap (8 MiB raw, 12 MiB action) where every other action
  keeps 48,000 bytes. The links it crosses all fit it: the skill socket takes
  request lines up to 13 MiB, and the host link and the browser socket take
  frames up to 16 MiB.
- **Replay.** A reconnect snapshot replays every object, images included, and
  sends each replayed action as its own WebSocket frame, so two images on stage
  (up to 24 MiB together) never share one 16 MiB frame
  (`browser::send_snapshot_sink`; tested with two 8 MiB images). The debug
  feed keeps an image display call as one record with `bytes` clipped to a
  field's 4 KiB bound.

## Explicitly Refused Patterns

- **General Raw HTML / Arbitrary Markup**: refused. Arbitrary HTML exposes the
  page (which holds active WebRTC / WebSocket call state) to XSS via prompt
  injection from external repositories. All display renders from structured data
  controlled by client code, written via `textContent`.
- **Layout / style fields from the agent**: refused. Any `layout`, `style`, `css`,
  `className`, or geometry field in an action is rejected — the page owns pixels.
- **Ad-hoc or unversioned transport sprawl**: refused. A display travels one
  path. The agent calls `switchboard.display` in the skill module, which sends
  a `display` call to the host agent on the host's skill socket; the host
  agent relays it, with the call token, as a module call over the host link
  (`docs/host-link.md`, "Module calls"); the service's `display` handler
  (`apps/backend/src/module_calls.rs`) validates it (`visual_protocol.rs`) and
  applies it under the display gate (`apps/backend/src/display.rs`); and the
  existing browser WebSocket delivers it, where the page validates it again.
  There is no HTTP route for it and no URL setting: the agent callback routes
  and `DISPLAY_URL` are retired (`docs/environment.md`).

## Resolved: the display extension hardships log

`DISPLAY_EXTENSION_ISSUES.md` recorded three problems found while dogfooding
the `display` tool before this phase. All three are resolved by the pieces
documented above:

1. **Schema validation confusion.** A `diagram` (or `document` / `note`)
   payload was rejected with an error that read like it wanted chart fields
   (`series`, `label`/`value`), regardless of the `type` actually sent. The
   validator now discriminates on `type` before checking shape, so a bad
   `diagram` payload is scored against the diagram schema and names which
   diagram field is wrong — not a chart's. See `docs/display-tool.md`'s per-type
   `data` table and the per-type `data` shapes in the `switchboard` skill
   module's `skills/switchboard/SKILL.md`.
2. **Silent failure: "On screen" when nothing rendered.** The display call
   used to report success the moment the action was handed to the delivery
   layer, with no signal that the browser ever actually painted it. That is
   exactly the gap the confirm/reject round trip above closes: it now waits
   for the browser's own `applied_seq` to reach the action's `seq` before
   calling it rendered, and the `display` tool's result text distinguishes
   "On screen." from "Sent, but the caller's screen has not confirmed it" and
   from an outright rejection carrying its reason.
3. **`view` contradicting what the caller actually saw.** The `view` tool
   used to report whatever the agent had last requested, independent of
   whether the browser ever confirmed it — so "Screen is in auto view with
   chart" could be true of the agent's intent and false of the caller's
   screen at the same moment. `view` with no target now reports that intent
   *and* a `confirmed` flag computed from the same watermark the display call
   waits on, and the tool text says "has not confirmed it yet" instead of
   asserting success.

The log itself stays in place with a note pointing here, rather than being
deleted, since it is the dogfooding evidence this phase was built to answer.
