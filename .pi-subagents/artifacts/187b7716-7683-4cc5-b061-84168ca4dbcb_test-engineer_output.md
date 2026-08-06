# Playback regression coverage

Added focused browser-harness assertions in `tests/test_app.mjs`:

- Tracks source URLs currently audible and verifies replacement pauses/cleans the old source before the next clip starts.
- Covers natural `ended` advancement with duplicate `ended`/late `pause` events, asserting one play of the next clip.
- Covers terminal seeking without click-resume, with both `pause -> ended` and `ended -> pause` orderings, plus duplicate events and FIFO advancement.

Commands:

- `node tests/test_app.mjs` passed.
- `npm test` passed, including TypeScript rebuild and all browser tests.
- `git diff --check` passed.

Remaining untested: a real browser's native media event scheduling and independently created hidden `HTMLAudioElement` instances. The harness models source ownership on the exposed player and catches an old source remaining audible during replacement.