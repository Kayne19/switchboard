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

## Engine-specific code in the tree

| Where | What | Why |
|---|---|---|
| `apps/frontend/src/styles/index.css`, `.calendar-event__title` | `display: -webkit-box` with `-webkit-line-clamp` | the prefixed form is the one both engines support for clamping lines |
| `apps/frontend/src/styles/index.css`, `::-webkit-scrollbar` beside `scrollbar-width: none` | prefixed scrollbar hiding | Safari before 18.2 has no `scrollbar-width` |

## Before a pin bump

Run this on the iPad, in Safari, against the build the pin will deploy.
Note the iPadOS version in the pull request.

1. Microphone: tap Damocles, speak, tap again. The words arrive as a turn,
   and the microphone light goes off.
2. Playback: Damocles' reply is heard, on the first call after the page
   loads as well as later ones.
3. Orb: the presence moves with Damocles' voice and with yours.
4. Hands-free, where the page offers it: the wake word and a sentence make
   a turn, without a tap.
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
9. Edges: in landscape and portrait, the corner marks, the scene heading
   and the foot of the stage are clear of the home indicator, and nothing
   but black lies outside them. CI cannot check this: Playwright has no
   safe-area insets, so the hygiene check only holds the viewport tag
   (see "Sizes worth checking").
