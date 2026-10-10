import { defineConfig } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/integration',
  timeout: 30_000,
  // On CI a run past this ends with the tests that did not finish named, a
  // little before the job's own timeout-minutes in .github/workflows/ci.yml.
  globalTimeout: process.env.CI ? 30 * 60_000 : 0,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
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
    command: 'npm --prefix ../.. run build && npm --prefix ../.. run preview -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
