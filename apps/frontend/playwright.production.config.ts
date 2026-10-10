import { defineConfig } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

// The production build is served on a port of its own (4173 is the dev
// server's, 4174 the debug dev server's, 4183 the browser suite's) by a
// server the suite starts and never reuses, for the reason
// playwright.config.ts gives. PLAYWRIGHT_INTEGRATION_PORT moves it, so two
// checkouts can run the suite at once.
const port = Number(process.env.PLAYWRIGHT_INTEGRATION_PORT || 4184);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/integration',
  // A focused test (`test.only`) on CI fails the run instead of running
  // alone and passing with every other spec skipped.
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  // On CI a run past this ends with the tests that did not finish named, a
  // little before the job's own timeout-minutes in .github/workflows/ci.yml.
  globalTimeout: process.env.CI ? 30 * 60_000 : 0,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: origin,
    colorScheme: 'dark',
    contextOptions: { reducedMotion: 'reduce' },
    permissions: ['microphone'],
  },
  // The production build in Chromium and in WebKit, the iPad's engine
  // (docs/ipad.md); `--project=chromium` or `--project=webkit` runs one.
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // A fake microphone lets the native runtime record without a device.
        launchOptions: {
          executablePath,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            ...(executablePath ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
          ],
        },
      },
    },
    // WebKit's own mock capture device stands in for the microphone.
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    // --strictPort: Vite would move to the next port when this one is taken,
    // and the suite would wait on the stranger still holding it.
    command: `npm --prefix ../.. run build && npm --prefix ../.. run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
