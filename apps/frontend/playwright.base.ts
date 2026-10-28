import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

type Suite = Pick<PlaywrightTestConfig, 'testDir' | 'projects' | 'snapshotPathTemplate' | 'use' | 'expect'> & {
  port: number;
  /** An npm script that passes its arguments through to Vite. */
  serve: string;
};

/** What the browser and integration suites share (#355). */
export function defineSuite({ port, serve, use, ...suite }: Suite) {
  const origin = `http://127.0.0.1:${port}`;
  return defineConfig({
    ...suite,
    forbidOnly: !!process.env.CI,
    timeout: 30_000,
    // Ends a CI run with the tests that did not finish named, a little before
    // the job's timeout-minutes in .github/workflows/ci.yml cuts the log off.
    globalTimeout: process.env.CI ? 30 * 60_000 : 0,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
      ...use,
      baseURL: origin,
      colorScheme: 'dark',
      contextOptions: { reducedMotion: 'reduce' },
      screenshot: 'only-on-failure',
      trace: process.env.CI ? 'retain-on-failure' : 'off',
    },
    webServer: {
      // Vite moves to the next port when this one is taken, and the suite
      // would wait on the stranger still holding it.
      command: `${serve} -- --host 127.0.0.1 --port ${port} --strictPort`,
      url: origin,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  });
}

/** The Chromium project, run from PLAYWRIGHT_CHROMIUM_PATH when it is set. */
export function chromium(extraArgs: string[] = []) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  return {
    name: 'chromium',
    use: {
      browserName: 'chromium' as const,
      launchOptions: { executablePath, args: [...extraArgs, ...(executablePath ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])] },
    },
  };
}
