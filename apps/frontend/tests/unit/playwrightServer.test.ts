import { afterEach, describe, expect, it, vi } from 'vitest';

// The browser suite starts its own server and never takes one it finds:
// a dev server from another checkout on the same port would otherwise be
// tested in its place, and the suite would report on the wrong code.

type ServerConfig = { command: string; url: string; reuseExistingServer: boolean };

async function loadConfig(port?: string) {
  vi.resetModules();
  if (port === undefined) vi.stubEnv('PLAYWRIGHT_PORT', '');
  else vi.stubEnv('PLAYWRIGHT_PORT', port);
  const { default: config } = await import('../../playwright.config');
  return { baseURL: config.use?.baseURL ?? '', server: config.webServer as ServerConfig };
}

const portOf = (url: string) => new URL(url).port;

afterEach(() => vi.unstubAllEnvs());

describe('the browser suite server', () => {
  it('is started for the suite, never reused', async () => {
    const { server } = await loadConfig();
    expect(server.reuseExistingServer).toBe(false);
  });

  it('is not on the dev server port, and the pages are read from the server it starts', async () => {
    const { baseURL, server } = await loadConfig();
    expect(portOf(baseURL)).not.toBe('4173');
    expect(portOf(server.url)).toBe(portOf(baseURL));
    expect(server.command).toContain(`--port ${portOf(baseURL)}`);
    // Vite moves to the next port when its own is taken; the suite must fail instead.
    expect(server.command).toContain('--strictPort');
    // The dev server listens on every interface; the suite's own stays local.
    expect(server.command).toContain('--host 127.0.0.1');
  });

  it('moves to the port PLAYWRIGHT_PORT names', async () => {
    const { baseURL, server } = await loadConfig('4999');
    expect(portOf(baseURL)).toBe('4999');
    expect(portOf(server.url)).toBe('4999');
    expect(server.command).toContain('--port 4999');
  });
});
