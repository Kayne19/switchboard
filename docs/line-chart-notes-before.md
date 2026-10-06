# Line-chart notes: the rules before round 4, and a ready revert

> **Open work.** Kayne has not decided yet. He previewed `visual-palette` @ `61c2596`
> and said: "I'm not sure that the line chart needed new note rules? document the old
> ones in case we revert, I think I liked the way it looked before but we'll see for
> now." This file records the old rules, the new rules, and the revert that is ready
> on branch `vp/line-notes-revert`. AGENTS.md lets a plan for open work live in
> `docs/` while the work is open. Delete this file when Kayne decides (git keeps it),
> and move anything still open into an issue.

## Where things stand

| | line, area and scatter notes | where |
|---|---|---|
| `abdf931` | the old rules (this file calls them "old") | `visual-palette` before round 4 |
| `950750d` | vp/line-notes merged: line notes follow the bar chart's rules | round 4 |
| `2f49155` | vp/notes-tidy merged: a line keeps 12 px clearance (row 15), `from` required with `point` (row 12) | round 5 |
| `61c2596` | the new rules, every later slice merged, static rebuilt | `visual-palette` now |
| `vp/line-notes-revert` | the old rules again, on top of `61c2596`; everything else kept | **unmerged**, for a live side-by-side |

The default is still the new rules. Nothing on `visual-palette` changes until Kayne
picks. The revert branch runs on its own dev server
(`npx vite --config apps/frontend/vite.config.ts --port 4572` in its worktree) beside
the coordinator's `:4173`.

## The two rule sets at a glance

| | old rules (`abdf931`, and the revert branch) | new rules (`61c2596`) |
|---|---|---|
| where a card goes | rows along the top and bottom of the layer, centred over its point; may lie **across the plot's border** | wholly inside the plot (8 px in) or wholly outside it, never across the border |
| level with its point | never (its leader always leaves by the top or bottom border), unless no place above or below is free | allowed: a card beside its point runs its leader out of its side |
| clearance from a line | 6 px, the same as from a bar or point | 12 px (`LINE_CLEARANCE`, notes-tidy row 15) |
| leader shape | out of the card's facing edge at right angles, one 45-degree step, straight on (`routeLeader`) | a callout leader (`calloutLeader`): from the facing edge, or out of the side, along, 45-degree turn |
| leader end | **on the line itself**, at the interpolated point | 3 units past a value printed by the point |
| leader colour | fades: the card's edge colour, 100% at the card, 50% halfway, 20% at the point | solid orange at 80% to the end |
| leader vs other lines | may cross another line (a crossing costs 300 a crossing, no hard rule) | must keep 4 px from every other line and mark, or the place is "astray" |
| the marker | a filled black ring, orange stroke, on the line; no value | a ring plus its **value printed** beside it; hollow on a scatter |
| a point a note names | no mark while its card is on the chart (the leader marks it); a hollow ring when its note is in the rail | ring plus printed value, always |
| TARGET tag | `TARGET / LOSS / X 32 / VAL LOSS` (object id, bare X) | `TARGET / EPOCH 32 / VAL LOSS` (axis name and value) |
| rail | a note naming no point goes first wherever its absence leaves no more cards astray; a line card is astray only over the data or too far along | a note leaves only where its absence leaves fewer astray; astray also covers a card over another card or a named point, or across the plot's border |

The revert branch takes the old column for everything about where a line card goes and
how its leader and point look. It keeps three things from the new column on purpose:
the TARGET tag (names, never ids), the rail rule (it is also the bar chart's rule), and the
marker ring as round-4 draws it (whole on the plot's edge, hollow on a scatter). Section
"The revert" says why.

## The old rules, exactly as at `abdf931`

Source: `git show abdf931:apps/frontend/src/primitives/notePlacement.ts`,
`git show abdf931:apps/frontend/src/components/ChartNotes.tsx`,
`git show abdf931:apps/frontend/src/primitives/ChartPrimitive.tsx`, and the reports
REPORT-chart-notes.md, REPORT-plan-scene.md and REPORT-charts.md. All sizes are CSS
pixels of the note layer.

### Where a card went

The scene measured each card at its stylesheet width. `layoutNotes` placed the cards one
by one: notes that name no point first (they take corners), then notes that name a
point, in the order given. For each card it scored a set of places and took the cheapest.

1. **Rows first.** Lefts: the point's x less half the card's width (centred over the
   point), and beside each card or label already placed (`left - 10 - width`,
   `right + 10`). Tops: the layer's top, the layer's bottom less the card's height, and
   above or below each placed card or label (a 10 px gap). Every place is clamped into
   the layer. A note with no point tries the two top corners instead of the centred left.
2. **Straight above or below the point.** Only where the best row covers the point,
   another note's point or another card, or is level with the point: tops
   `point.y - 10 - height` and `point.y + 10`, at every row left.
3. **Beside the point, last.** Level with it, 24 px to either side (`BESIDE_POINT`).
4. **The search.** Only where nothing above is clear of the data: every left within
   reach (the point at most a third of the card's width past its span, 16 px from a
   corner), each free vertical run between what is in the way. Three passes: clear of
   everything, then over a fill at most, then over fills and labels at most. Never over
   the data.

A place ranked by what it fell short by, then by cost:

| tier | cost | what |
|---|---|---|
| own point | 1e9 | the card covers its point (within 6 px) |
| another note's point | 1e8 | |
| another card | 1e7 + 100 per px² | |
| skirting | 2e6 | its point within 6 px of the top or bottom border line (a leader would run along the border) |
| level | 1e6 | its point's height inside the card, 6 px in from top and bottom (a leader would leave by a side) |
| over the data | 5e5 + 40 per px of line + 1 per px² of mark | a line, a bar, a scatter point or the marker ring within **6 px** (`DATA_CLEARANCE`) |
| far | 2e5 + 10 per px | the point more than a third of the card's width past the stretch of edge its leader may leave from (16 px in from each corner) |
| labels | 1e5 + 0.5 per px² | the legend, the axes' label strips |
| fill | 5e4 + 0.05 per px² | an area chart's fill |
| per pixel | | leaders of other notes under it (80/px), its leader under other cards (80/px), its leader across a line (300 a crossing) or through a mark (3/px), its share of the plot (0.01/px²), off centre over its point (2.5/px), its leader's length (0.25/px), a leader shorter than 10 px (20/px short), a row low on the layer (60), a no-point card in the right corner (20) |

There was **no** "wholly in or out of the plot" rule for a line, area or scatter chart:
`NoteField.wholly` was set for bar charts only. That is why the approved training card
lies across the plot's top border and past its right edge at 1440x900 and 2560x1080.

Short charts (REPORT-plan-scene.md): a card alone ends up beside its point only where it
is taller than the room above and below its point, less 6 px.

### How the leader was drawn

- `layoutNotes` scored each place with `routeLeader(card, point)`. ChartNotes then
  rounded the card to whole pixels and routed the drawn leader again:
  `routeLeader(rounded, point, { cutTop: NOTE_CARD_CUT.top, overlap: 1 })`.
- Out of the card's edge that faces the point, at right angles, 1 px inside the border so
  the two read as one line. The exit stays 16 px from the corners and clear of the
  corner the card's outline cuts (8% of the top edge).
- A first straight run of 12 px (or a third of the way), one 45-degree step of up to
  26 px across, and a last straight run onto the point (12 px, or a quarter of the way).
  A point further across than the step reaches gets a run along the edge first.
- It ends **exactly on the point on the drawn series** (interpolated between samples,
  held inside the plot). There is no value there to land by.
- Each vertex on the half pixel (crisp one-pixel line).
- A per-leader `linearGradient` along it: `--chart-note-edge` at opacity 1 at the card,
  0.5 halfway, 0.2 at the point. A bar's leader used the same gradient with every stop
  at orange 0.8 (`.chart-note-leader--bar`).

### The marker

- `ChartPrimitive` drew a ring on the marker's point, on the drawn series: radius 5,
  stroke 2 (`CHART_MARKER_RADIUS`, `CHART_MARKER_STROKE`), black fill, orange stroke, the
  same black fill on a scatter. 2 units larger in focus.
- Inside the plot's clip group: a ring on the plot's edge was cut in half (a wave 1 open
  item).
- No guide line and **no printed value**.
- A point a note named was **not marked** while its card was on the chart: the leader
  ending on the line marked it. In the training fixture the note names the marker's
  point, so the marker's ring is where the leader ends.

### The TARGET tag

- On a chart without `labels`: `TARGET / {anchor.target} / X {x} / {series}`, the anchor
  as sent, upper-cased by the stylesheet: `TARGET / LOSS / X 32 / VAL LOSS`. `loss` is
  the chart's object id, which the caller never sees.
- On a chart with `labels`: the category and the series (`TARGET / JUL / ORGANIC`).

### When a note went to the rail

- Only the primary chart's notes could go (`spill`), and only one note.
- A card was **astray** when its best place lay over the data, or was too far along from
  its point (the "far" tier), or (bars only) had no clear leader. A card that was level
  with its point, skirting it, over another card or across a border was **not** astray.
- If any card was astray: a note naming **no point** left wherever its absence left no
  more cards astray, even if that cleared none (357a199). Otherwise a note naming a
  point left only where its absence left fewer astray. Ranking: no point first, then
  fewest astray, then one astray itself, then the cheapest.
- The card stayed in the layer out of view (`chart-note--away`). ChartNotes drew a
  hollow orange ring (`.chart-note-ring`, the marker's radius and stroke) on the point
  the note named, so the rail card's words still pointed at something.

## The new rules, as at `61c2596`

Sources: REPORT-line-notes.md (round 4) and REPORT-notes-tidy.md (round 5, rows 12, 14,
15 and L2-L9).

- **Every point a note names is a callout** (`chartPointCallouts`, d0245f7): a ring
  (filled on a line, hollow on a scatter) and the value printed beside it, drawn whole
  past the plot's clip. The value goes above, below, offset, or beside the ring, by the
  clear room past it (f746956).
- **Wholly in or out** (37b1d40): `field.wholly = true` for every kind. A card lies 8 px
  inside the plot or a gap outside it.
- **Callout leader** (37b1d40, `calloutLeader`, was `barLeader`): lands 3 units past the
  printed value, from the side it is printed on; out of the card's facing edge, or out
  of its side, a run along and a 45-degree turn. A route within 4 px of another line,
  point, ring or value is not clear. Solid orange 0.8; the gradient is gone.
- **Line clearance 12 px** (574c600, notes-tidy row 15): a card keeps 12 px from a line,
  6 px from a mark.
- **Free point path deleted** (6da0c2b, row 12): `NoteToPlace` needs `from` with `point`;
  the level/skirting/shift/leader/hug costs, `SEARCH_REACH` and the point's band in the
  search are gone.
- **Tag** (0a87ae6, then L5/L7 and last-gaps `noteTarget`): `TARGET / EPOCH 32 / VAL LOSS`.
- **Rail rule** (14e92b5, d401bb1): a card is astray where it falls short by "far" or
  worse (over the data, too far, no clear leader, across the border, over another card
  or a named point); a note leaves only where its absence leaves fewer astray; the
  fewest first, then a note naming no point.
- The effect (REPORT-line-notes.md section C): more line notes go to the rail (crossing
  lines, dense scatter stretches, a peak with a narrow tent under it, the compare layout
  at 1440 and 1280).

## Side by side

Screenshots are in `/home/kayne19/projects/switchboard-wt/shots-line-notes-revert/`:

- `before/<case>-<WxH>.png`: `visual-palette` @ `61c2596` (new rules).
- `<case>-<WxH>.png`: `vp/line-notes-revert` (old rules).
- `compare-<case>-<WxH>.png`: the two side by side, new rules on the left.
- `contact-<WxH>.png` and `before/contact-<WxH>.png`: every case at one geometry.
- `golden/`: the training goldens, approved vs `visual-palette` vs revert, and diffs.
- `cases.json`: the actions of every case; `shot.cjs` takes them.

Geometries: 390x844, 820x1180, 1440x900, 2560x1080, 1280x720, 844x390. Cases: the
training fixture, a second note (training-two), three notes on a short chart, a compare
pair, focus (one and two notes), area (one and two notes), dense and sparse scatter, a
labelled line, a peak on the axis top, three crossing lines, a general note; the bar
cases comparison, two-notes and full-bars (unchanged by the revert); and a note on a
line chart in the aux row.

Where each note ends up: "chart" (every note on the chart), "rail X" (note X in
the rail), "band" (one note in the band under the chart, on a portrait stage), "rail X +
band" (one in each, so the chart holds none of a two-note case). A cell reads
`new → **old**` where the revert moves a note, and one value where both agree. The
three bar cases and the aux-cell case agree everywhere.

| case | 390x844 | 820x1180 | 1440x900 | 2560x1080 | 1280x720 | 844x390 |
|---|---|---|---|---|---|---|
| training | chart | chart | chart | chart | chart | rail training-note |
| training-two | rail early-note + band → **chart** | chart | chart | chart | chart | rail early-note → **rail training-note** |
| training-short-3notes | rail general-note + band | band | rail general-note | rail general-note → **chart** | rail general-note | rail general-note |
| training-compare | rail training-note → **chart** | chart | rail training-note → **chart** | chart | rail training-note | rail training-note |
| focus-training | chart | chart | chart | chart | chart | rail training-note |
| area | band → **chart** | chart | chart | chart | chart | rail traffic-note |
| area-two | rail ref-note + band → **chart** | band → **chart** | rail ref-note → **chart** | rail ref-note → **chart** | rail ref-note → **chart** | rail traffic-note |
| scatter-dense | band → **chart** | band → **chart** | rail lat-note → **chart** | chart | rail lat-note → **chart** | rail lat-note |
| scatter-sparse | chart | chart | chart | chart | chart | chart |
| line-labelled | chart | chart | chart | chart | rail merge-note → **chart** | rail merge-note → **chart** |
| line-peak-top | band → **chart** | band → **chart** | rail cpu-note → **chart** | chart | chart | rail cpu-note |
| line-crossing | band → **chart** | band → **chart** | rail svc-note → **chart** | rail svc-note → **chart** | rail svc-note → **chart** | rail svc-note |
| training-general | rail training-note + band → **band** | chart | rail general-note → **chart** | chart | rail general-note → **chart** | rail general-note |
| comparison | chart | chart | chart | chart | chart | rail durations-note |
| two-notes | band | chart | chart | chart | chart | rail durations-note |
| full-bars | band | chart | rail full-note | rail full-note | rail full-note | rail full-note |
| aux-line-note | chart | chart | chart | chart | chart | chart |
| focus-training-two | rail early-note + band → **chart** | chart | chart | chart | chart | rail early-note → **rail training-note** |

Against the `abdf931` shots (`shots-line-notes/before/`), the revert sends the same
notes to the rail in every line case. The only differences come from later work it
keeps: the band on a portrait phone (phone-stage) and, at 844x390, the rule that a card
on a short chart needs room for its header and a few lines (8d3089e).

Pairs to look at first (`compare-<case>-<WxH>.png`):

| what | pair |
|---|---|
| the approved training card, top row across the border, fading leader | `compare-training-1440x900.png`, `compare-training-2560x1080.png`, `golden/landscape-training-compare.png`, `golden/ultrawide-training-compare.png` |
| two notes, both in the top row | `compare-training-two-1440x900.png` |
| a card the new rules sent to the rail, back on the chart | `compare-line-crossing-1440x900.png`, `compare-area-two-1440x900.png`, `compare-scatter-dense-1440x900.png`, `compare-training-compare-1440x900.png` |
| a phone | `compare-training-390x844.png`, `compare-area-390x844.png`, `compare-line-peak-top-390x844.png` |
| focus, two notes: no values, a hollow ring on the second point | `compare-focus-training-two-1440x900.png` |
| a note in the rail about a line chart in the aux row: hollow ring | `compare-aux-line-note-1440x900.png` |
| bar charts, unchanged | `compare-comparison-1440x900.png`, `compare-two-notes-1440x900.png`, `compare-full-bars-1440x900.png` |


## The revert

### What the branch does

Branch `vp/line-notes-revert`, on top of `61c2596`: `9516af4` (code and tests), `1d129f6`
(docs), `4226a93` (review fixes), then the commit that adds this file (on its own, so it
can be cherry-picked without the revert). Range: `61c2596..vp/line-notes-revert`. It is the code,
not a flag: there is one placement path, and a line note takes it with no `from`.

- `notePlacement.ts`: the free point path is back as at `abdf931` (the
  level/skirting tiers, the off-centre/length/hug costs, `SEARCH_REACH`, the point's
  band in the search, rows scored off the whole-pixel grid). `NoteToPlace` takes `point`
  without `from` again; `from`, `bar` and `value` are a bar's. `LINE_CLEARANCE` is gone:
  a line keeps 6 px. `calloutLeader` is `barLeader` again (it only serves bars), without
  the line checks a bar chart never needs. `routeLeader` takes `cutTop` again.
- `chartGeometry.ts`: `chartPointCallouts` and its helpers are gone. `chartNoteTarget`
  gives a line point with no side. `ChartScales.scale` and `chartScaleStep` (only the
  callouts read them) are gone. New: `chartRings`.
- `ChartNotes.tsx`: `wholly` for bar charts only; a line leader is routed on the rounded
  card (`routeLeader`, `cutTop`, overlap 1) and drawn with the fading gradient; a bar's
  keeps its solid colour through `chart-note-leader--bar`.
- `ChartPrimitive.tsx` + `chartRings`: the marker's ring, no value; a hollow ring
  (`.chart-note-ring`, the `abdf931` rail ring's look) on a point a note names that no
  leader on the chart reaches. The scene says which points the leaders reach
  (`led`): the notes on the chart less the one it left for the rail. So the rail ring of
  `abdf931` now comes from the chart, and the same ring marks a point whose note is in
  the band (phone-stage), in a focus panel (notes-tidy row 11) or in the rail beside a
  chart in the aux row (last-gaps 260f093). Those three came after `abdf931` and need
  the point marked; at `abdf931` only the rail case existed.
- CSS: the leader gradient stops and `.chart-note-ring` are back; `.chart-marker__value`
  is gone.

### Kept from the later work

| kept | why |
|---|---|
| bar-chart rules (wholly in or out, `barLeader`, sizes, perf of 2e11da6 and 8237ccd, 384c6a1's "always the topmost height") | a bar chart behaves as on `visual-palette`; the comparison, two-notes and full-bars shots match |
| the rail rule of 14e92b5 and d401bb1 | it is also the bar chart's rule, and one rule serves every chart. For a line note it also counts a card level with its point, or over another card, as astray, which `abdf931` did not. See the case table above for where that moves a note |
| TARGET from `noteTarget` (never ids) | `TARGET / EPOCH 32 / VAL LOSS`, not `TARGET / LOSS / X 32 / VAL LOSS` |
| notes in focus (`focusNotes`), the band, the aux-cell mark | each now marks a line point with the hollow ring |
| placement once a size step (row 14) | unchanged; the line leader follows its card between steps |
| the segment module (L8), `crispLine` and `withoutRepeats` (L9) | unchanged |
| one ring and point radius in focus (L2) | the ring is 5 units in focus too, not 7 |
| the marker ring drawn whole past the plot's clip, and hollow on a scatter | from d0245f7; it fixed two known defects (a half ring on the plot's edge, a filled ring hiding the scatter point it marks) and changes no placement inside the plot |

### The training goldens

Run on `:4572` with an untracked copy of `playwright.config.ts`:
`visual.spec.ts -g training`: landscape and ultrawide pass; portrait-phone and
portrait-tablet fail, as on `visual-palette` (the charts slice recomposed portrait
charts; those goldens wait on Kayne).

Pixels that differ from the approved golden (more than 30 in RGB sum):

| golden | `visual-palette` | revert | what is left |
|---|---|---|---|
| landscape-training | 18548 (1.43%) | 4568 (0.35%) | the TARGET text; the presence emblem and the progress fill (the golden caught them mid-animation) |
| ultrawide-training | 20928 (0.76%) | 653 (0.02%) | the TARGET text; a dashed marker guide the golden still has, removed before `abdf931` |

The card and its leader are pixel-identical to the approved goldens in both.
`golden/<geometry>-training-compare.png` shows approved, `visual-palette` and revert.

### How to take it, or drop it

- **Take the old rules:** merge `vp/line-notes-revert` into `visual-palette`, rebuild
  `static/` and `static-debug/` once, run every gate and the visual suite. The landscape
  and ultrawide training goldens then match again. Then delete this file.
- **Keep the new rules:** delete the branch. Cherry-pick only the commit that adds this
  file if the record should stay until the decision is final.
- **Mix:** each old rule is one place in the code. To keep the printed value but the old
  card place, for example, start from this branch and add back `chartPointCallouts` for
  drawing only. Ask Kayne first.

## Open (seen while checking the revert; not changed here)

1. A crowded short chart on a phone (three notes under a stepped plan, 390x844) and a
   phone on its side (844x390) read cramped under both rule sets: a card's text scrolls
   in its card. That is phone-stage's open item b, not a line-note rule.
2. Under the old rules a card may cover the axis labels or lie over the data where the
   chart has no clear place (the label and data tiers rank after "level"), for example
   the second note on a phone (`compare-training-two-390x844.png`). The new rules sent
   such a note to the rail or the band instead. This is the trade Kayne is choosing.
3. The ring round the note the chart leaves for the rail is not a mark the other cards
   keep off; its point is (6 px, as any named point). At `abdf931` the same held for the
   ring ChartNotes drew there. A card can touch that ring's edge on a crowded chart.
   The band's ring is a mark the cards keep off.
4. The page logs "flushSync was called from inside a lifecycle method" from ChartNotes'
   canvas finder (phone-tidy 6dbea70) on every chart, on `visual-palette` and on this
   branch alike.
