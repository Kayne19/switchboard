# iPad (WebKit) is a first-class target

The iPad is where switchboard is used most. Every browser on iPadOS is
Safari's engine, WebKit, whatever its name. A change that works in desktop
Chromium and breaks on the iPad is broken (#187).

## What CI checks

- `npm run test:browser` and `npm run test:integration` run every spec in two
  Playwright projects, `chromium` and `webkit` (`apps/frontend/playwright.config.ts`,
  `apps/frontend/playwright.production.config.ts`). CI's `browser` job runs
  each engine in its own legs. `-- --project=webkit` runs one engine locally.
- The pixel goldens are Chromium's alone. They were drawn in it on the dev
  box, and WebKit rasters text and strokes its own way. WebKit's layout is
  held by the geometry specs: what crosses a frame, where a frame's lines
  lie (`frameStroke.spec.ts`), the rail, the lists, the calendar.

## What CI cannot check

Playwright's WebKit is a Linux build. It is not iPadOS Safari:

- It has no `MediaRecorder`, so push-to-talk recording cannot be driven there
  (`callRuntime.spec.ts` skips that spec in a build without it).
- It draws through its own compositor, not Core Animation and the iPad's GPU
  process. A clip, mask or blur can snap to device pixels differently there.
- It has no audio session, no autoplay policy of the iPad's, no real touch,
  and no Safari toolbars. The iPad's display is OLED: a fill a few levels
  above black can read as black there.
- Only a gesture's own `play()` unlocks the single audio element, and
  Playwright cannot make a real gesture. A tap during the first reply's
  opening must unlock it, so the reply plays without a second tap (item 2
  of the checklist, the first reply after page load).

So the device checklist below stays.

## Sizes worth checking

The iPad Pro 13-inch lays out at 1376x1032 (landscape) and 1032x1376
(portrait) CSS pixels at 2x; Safari's toolbars take about 70 px of the
height. Split View and Stage Manager give narrower windows (about a half and
a third of the width). The layout reads only the stage's own geometry
(`apps/frontend/ARCHITECTURE.md`, "Layout"), so these are sizes to test at,
never breakpoints.

The page does not ask to be drawn under the display's cut-outs: its viewport
tag has no `viewport-fit=cover`. Safari then lays it out inside the safe
area, clear of an iPhone's notch on its side and a Face ID iPad's home
indicator, and the stage's box is still all the layout reads. A change that
wants the page full-bleed pads it by `env(safe-area-inset-*)` in the same
change; `scripts/check_hygiene.mjs` refuses the one without the other.

## Rules

- One implementation for both engines. No user-agent checks, no WebKit-only
  CSS, no second path. Where WebKit lacks a feature, detect the feature.
- A browser runtime change (audio, capture, playback, gestures) says in its
  pull request what it does on WebKit.
- A user-agent branch is a last resort. It names the WebKit bug it works
  around in a comment, and it is listed below until it is removed.
  `scripts/check_hygiene.mjs` refuses a `navigator.userAgent`, `userAgentData`,
  `vendor` or `platform` read in `apps/frontend/src` in a file the table
  below does not name, and an `@supports` or `@media` query on a `-webkit-`
  or `-apple-` feature.

## Engine-specific code in the tree

`scripts/check_hygiene.mjs` reads this table. Each row starts with the
repo-relative file as its first code span, and every `-webkit-` name in its
Where and What cells is a claim that the file uses it. The script refuses a
`-webkit-` name (or its camelCase style key, such as `WebkitLineClamp`) used in
`apps/frontend/src` that no row lists for its file, and a row that lists one its
file does not use.

| Where | What | Why |
|---|---|---|
| `apps/frontend/src/styles/index.css`, `.calendar-event__title` | `display: -webkit-box` with `-webkit-box-orient` and `-webkit-line-clamp` | the prefixed form is the one both engines support for clamping lines |
| `apps/frontend/src/styles/index.css`, `::-webkit-scrollbar` beside `scrollbar-width: none` | prefixed scrollbar hiding | Safari before 18.2 has no `scrollbar-width` |
| `apps/frontend/src/debug/debug.css`, `summary::-webkit-details-marker` beside `list-style: none` (debug page only) | prefixed disclosure-marker hiding | WebKit draws a `<summary>`'s triangle through this pseudo-element, which `list-style: none` does not reach in every Safari the iPad may run |

## Before a pin bump

Run this on the iPad, in Safari, against the build the pin will deploy.
Note the iPadOS version in the pull request.

1. Microphone: tap Damocles, speak, tap again. The words arrive as a turn,
   and the microphone light goes off. Where Safari asks for the microphone,
   tap Damocles again while its prompt is open, then allow: nothing is
   recorded, the microphone light goes off, and the next tap records.
2. Playback: Damocles' reply is heard, on the first call after the page
   loads as well as later ones. (A reply past a playback cap, 32 MiB in one
   utterance or 64 MiB waiting unplayed, is cut there and the status line
   says so; it keeps streaming on WebKit too. A run cannot reach the caps,
   so unit tests in `audioPlayback.test.ts` hold this, not the device.)
3. Orb: the presence moves with Damocles' voice and with yours.
4. Hands-free, where the page offers it: the wake word and a sentence make
   a turn, without a tap. Then tap Damocles, speak, tap again: MODE still
   says HANDS-FREE, and the wake word still makes a turn. Ask to be put
   through to a project, and later back to the operator: after each
   hand-off MODE still says HANDS-FREE, the microphone light stays on, and
   the wake word makes a turn with the new agent. A regression guard, not proof
   that the guarded branch ran: master gives the same result, so a pass
   shows only that the page still recovers. On a fresh page, tap MODE,
   allow the microphone, and leave Safari at once. Come back: MODE says
   PUSH-TO-TALK, the status line shows no error, and the next MODE listens.
5. Captions: the answer card's text follows what is said.
6. Frames: the answer card shows its dark fill and all four edges; the
   corner marks are whole; a chart, a document and a table show their
   frames. Rotate to portrait and back, and check again.
7. Split View at half width: the page recomposes and nothing is cut off.
8. Swipe: on a calendar week (the phone-width paged one), swipe across the
   hours and across the day row. The days turn, and the page itself does
   not scroll or rubber-band. CI cannot check this: Playwright has no
   engine-neutral touch drag, so `calendar.spec.ts` sends a synthetic
   touch sequence in the page and only the scroller's computed
   `touch-action: pan-y` is asserted. Whether the browser hands the pan
   over is the device's answer.
9. Reconnect: tap Damocles and start speaking, then send Safari to the
   background for longer than the keepalive (about 30 s) and come back.
   The page says it reconnected, the words said before backgrounding
   arrive as a turn, the microphone light is off, and the next tap
   records.
10. Edges: in landscape and portrait, the corner marks, the scene heading
   and the foot of the stage are clear of the home indicator, and nothing
   but black lies outside them. CI cannot check this: Playwright has no
   safe-area insets, so the hygiene check only holds the viewport tag
   (see "Sizes worth checking").
11. Hand-off speech: ask the operator to put you through to a project while
    it is still speaking. What it is saying is heard to its end, and the
    project's first words follow it; nothing is cut off and nothing
    overlaps. The page streams through `MediaSource` where Safari offers it
    for MP3 (it does not use `ManagedMediaSource`), and replays a clip
    whole where it does not or where a stream stops sounding; if the
    status line says a stream fell back to the complete replay, note that
    the order held there too. `streamPlayback.spec.ts`, "a
    handoff in this engine", plays the same order in WebKit on CI, without
    the iPad's audio session.
12. Theater: ask the agent to give a chart the whole screen. The chart fills
    the stage with its note, and EXIT, MODE and Damocles are clear of the
    toolbars and the home indicator, in landscape and portrait. Tap Damocles
    and speak: the turn goes as on any page. Tap TRANSCRIPT HIDDEN under the
    box: the history opens over the view, and RETURN puts you back in it.
    Tap EXIT: the page goes back to the chart's own page.
13. System: ask the agent for the system view. Each picker opens Safari's
    own picker; pick a thinking level and the line says so when the leg
    confirms it. HANG UP puts you back with the operator. Tap TRANSCRIPT
    HIDDEN under the panel: the history opens over the view, and RETURN puts
    you back in it. Rotate: the panel stays clear of MODE and Damocles, and
    on a phone on its side it scrolls.

## After a pin bump

Once the bump has deployed, reload the page on the iPad and on any other
device that had it open. The page never reloads itself, so a page left open
keeps running the build it loaded against the new service.
