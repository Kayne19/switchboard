import { defineConfig } from '@playwright/test';
import path from 'node:path';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

// The suite starts its own server on a port of its own (4173 is the dev
// server's) and refuses one it finds there: a server from another checkout
// would otherwise be tested in this tree's place, and the suite would report
// on the wrong code. PLAYWRIGHT_PORT moves it, so two checkouts can run the
// suite at once.
const port = Number(process.env.PLAYWRIGHT_PORT || 4183);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/visual',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: origin,
    colorScheme: 'dark',
    // The zone the fixtures are written in (their "now" is Pacific), so a run
    // on a runner in UTC reads the page as the dev box does.
    timezoneId: 'America/Los_Angeles',
    contextOptions: { reducedMotion: 'reduce' },
    // What a failed run leaves to read: a screenshot always, and on CI, where
    // nobody can rerun it by hand, the trace.
    screenshot: 'only-on-failure',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    launchOptions: executablePath ? {
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    } : undefined,
  },
  webServer: {
    // --strictPort: Vite would move to the next port when this one is taken,
    // and the suite would wait on the stranger still holding it.
    command: `npm --prefix ../.. run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  snapshotPathTemplate: path.join(import.meta.dirname, 'reference/golden/{arg}{ext}'),
});
