import type { PlaywrightTestConfig } from '@playwright/test';
import { vi } from 'vitest';

/** The two Playwright suites, each with the environment variable that moves its port. */
export const suites = {
  browser: { load: () => import('../../playwright.config'), port: 'PLAYWRIGHT_PORT' },
  integration: { load: () => import('../../playwright.production.config'), port: 'PLAYWRIGHT_INTEGRATION_PORT' },
};

export type SuiteName = keyof typeof suites;
export const suiteNames = Object.keys(suites) as SuiteName[];

/** A suite's config, loaded with these variables set; undo them with vi.unstubAllEnvs(). */
export async function loadSuite(name: SuiteName, env: Record<string, string> = {}): Promise<PlaywrightTestConfig> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await suites[name].load()).default;
}

export function serverOf(config: PlaywrightTestConfig) {
  const { webServer } = config;
  if (!webServer || Array.isArray(webServer)) throw new Error('the suite starts one server');
  return webServer;
}
