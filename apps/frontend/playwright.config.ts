import path from 'node:path';
import { chromium, defineSuite } from './playwright.base';

// The suite starts its own server on a port of its own (4173 is the dev
// server's) and refuses one it finds there: a server from another checkout
// would otherwise be tested in this tree's place, and the suite would report
// on the wrong code. PLAYWRIGHT_PORT moves it, so two checkouts can run the
// suite at once.
const port = Number(process.env.PLAYWRIGHT_PORT || 4183);

export default defineSuite({
  testDir: './tests/visual',
  port,
  serve: 'npm --prefix ../.. run dev',
  expect: { timeout: 5_000 },
  use: {
    // The zone the fixtures are written in (their "now" is Pacific), so a run
    // on a runner in UTC reads the page as the dev box does.
    timezoneId: 'America/Los_Angeles',
  },
  // Every spec runs in Chromium and in WebKit, the iPad's engine
  // (docs/ipad.md); `--project=chromium` or `--project=webkit` runs one.
  // The pixel goldens are Chromium's alone: they were drawn in it on the dev
  // box, and WebKit rasters text and strokes its own way, so WebKit's layout
  // is held by the geometry specs instead.
  projects: [
    chromium(),
    { name: 'webkit', use: { browserName: 'webkit' }, grepInvert: /@golden/ },
  ],
  snapshotPathTemplate: path.join(import.meta.dirname, 'reference/golden/{arg}{ext}'),
});
