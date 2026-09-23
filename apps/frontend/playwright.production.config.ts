import { defineConfig } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/integration',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    colorScheme: 'dark',
    contextOptions: { reducedMotion: 'reduce' },
    // A fake microphone lets the native runtime record without a device.
    permissions: ['microphone'],
    launchOptions: {
      executablePath,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        ...(executablePath ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      ],
    },
  },
  webServer: {
    command: 'npm --prefix ../.. run build && npm --prefix ../.. run preview -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
