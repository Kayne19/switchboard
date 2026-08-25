import { defineConfig } from '@playwright/test';
import path from 'node:path';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/visual',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'dark',
    contextOptions: { reducedMotion: 'reduce' },
    launchOptions: executablePath ? {
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    } : undefined,
  },
  webServer: {
    command: 'npm --prefix ../.. run dev -- --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  snapshotPathTemplate: path.join(import.meta.dirname, 'reference/golden/{arg}{ext}'),
});
