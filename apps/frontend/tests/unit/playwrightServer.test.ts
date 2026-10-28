import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSuite, serverOf, suiteNames, suites, type SuiteName } from './playwrightSuites';

const portOf = (url: string | undefined) => new URL(url ?? '').port;

afterEach(() => vi.unstubAllEnvs());

describe.each(suiteNames)('the %s suite server', (name: SuiteName) => {
  const load = async (port = '') => {
    const config = await loadSuite(name, { [suites[name].port]: port });
    return { baseURL: config.use?.baseURL, server: serverOf(config) };
  };

  it('is started for the suite, never reused', async () => {
    expect((await load()).server.reuseExistingServer).toBe(false);
  });

  it('is on a port of its own, and the pages are read from the server it starts', async () => {
    const { baseURL, server } = await load();
    const other = await loadSuite(name === 'browser' ? 'integration' : 'browser');
    // 4173 is the dev server's, 4174 the debug dev server's (npm run dev:debug).
    expect(['4173', '4174', portOf(other.use?.baseURL)]).not.toContain(portOf(baseURL));
    expect(portOf(server.url)).toBe(portOf(baseURL));
    expect(server.command).toContain(`--port ${portOf(baseURL)}`);
    expect(server.command).toContain('--strictPort');
    expect(server.command).toContain('--host 127.0.0.1');
  });

  it(`moves to the port ${suites[name].port} names`, async () => {
    const { baseURL, server } = await load('4999');
    expect(portOf(baseURL)).toBe('4999');
    expect(portOf(server.url)).toBe('4999');
    expect(server.command).toContain('--port 4999');
  });
});
